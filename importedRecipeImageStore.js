import { createHash } from "node:crypto";

const BUCKET = "imported-recipe-images";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15000;

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function safeUrlForLog(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(invalid image URL)";
  }
}

function getStorageConfig() {
  const supabaseUrl = cleanBaseUrl(process.env.SUPABASE_URL);
  const secretKey = String(process.env.SUPABASE_SECRET_KEY || "").trim();

  if (!supabaseUrl || !secretKey) {
    return null;
  }

  return {
    supabaseUrl,
    secretKey,
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isPersistedImportedRecipeImageUrl(value) {
  const config = getStorageConfig();
  if (!config || !value) return false;

  return String(value).startsWith(
    `${config.supabaseUrl}/storage/v1/object/public/${BUCKET}/`
  );
}

function detectImageFormat(buffer, contentType = "") {
  const mime = String(contentType)
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (mime === "image/jpeg" || mime === "image/jpg") {
    return { mime: "image/jpeg", extension: "jpg" };
  }

  if (mime === "image/png") {
    return { mime: "image/png", extension: "png" };
  }

  if (mime === "image/webp") {
    return { mime: "image/webp", extension: "webp" };
  }

  if (mime === "image/gif") {
    return { mime: "image/gif", extension: "gif" };
  }

  if (mime === "image/avif") {
    return { mime: "image/avif", extension: "avif" };
  }

  // Some CDNs return application/octet-stream, so sniff common
  // browser-safe raster formats before rejecting the response.

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mime: "image/jpeg", extension: "jpg" };
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mime: "image/png", extension: "png" };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", extension: "webp" };
  }

  const gifHeader = buffer.toString("ascii", 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { mime: "image/gif", extension: "gif" };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 4, 8) === "ftyp"
  ) {
    const brand = buffer.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") {
      return { mime: "image/avif", extension: "avif" };
    }
  }

  return null;
}

async function readBodyWithLimit(response) {
  const contentLength = Number(
    response.headers.get("content-length") || 0
  );

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_IMAGE_BYTES
  ) {
    throw new Error(
      `Remote image exceeds ${MAX_IMAGE_BYTES} byte limit`
    );
  }

  if (!response.body) {
    throw new Error("Remote image response had no body");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;
    if (!value?.length) continue;

    totalBytes += value.length;

    if (totalBytes > MAX_IMAGE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation cleanup failures.
      }

      throw new Error(
        `Remote image exceeds ${MAX_IMAGE_BYTES} byte limit`
      );
    }

    chunks.push(Buffer.from(value));
  }

  if (totalBytes === 0) {
    throw new Error("Remote image was empty");
  }

  return Buffer.concat(chunks, totalBytes);
}

async function downloadRemoteImage(
  imageUrl,
  sourcePageUrl = ""
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DOWNLOAD_TIMEOUT_MS
  );

  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    };

    if (isHttpUrl(sourcePageUrl)) {
      headers.Referer = sourcePageUrl;
    }

    const response = await fetch(imageUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Remote image request returned ${response.status}`
      );
    }

    const buffer = await readBodyWithLimit(response);

    const format = detectImageFormat(
      buffer,
      response.headers.get("content-type") || ""
    );

    if (!format) {
      throw new Error(
        `Unsupported remote image type: ${
          response.headers.get("content-type") || "unknown"
        }`
      );
    }

    return {
      buffer,
      ...format,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadImageToStorage(
  buffer,
  mime,
  extension
) {
  const config = getStorageConfig();

  if (!config) {
    throw new Error(
      "Supabase image storage is not configured"
    );
  }

  // Content-addressed filenames automatically deduplicate the
  // same image without depending on temporary CDN URL tokens.
  const hash = createHash("sha256")
    .update(buffer)
    .digest("hex");

  const objectPath =
    `${hash.slice(0, 2)}/${hash}.${extension}`;

  const uploadUrl =
    `${config.supabaseUrl}/storage/v1/object/` +
    `${BUCKET}/${objectPath}`;

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: config.secretKey,
      "Content-Type": mime,
      "Cache-Control": "31536000",
      "x-upsert": "false",
    },
    body: buffer,
  });

  const uploadText = await uploadResponse.text();

  let uploadPayload = null;

  try {
    uploadPayload = uploadText
      ? JSON.parse(uploadText)
      : null;
  } catch {
    // A successful upload does not need a JSON response.
  }

  // Supabase Storage may report an existing object with an
  // HTTP 400 response while the body identifies it as a 409
  // KeyAlreadyExists condition. Because our object path is
  // content-addressed by SHA-256, an existing key means the
  // identical image is already safely stored.
  const duplicateObject =
    uploadResponse.status === 409 ||
    uploadPayload?.statusCode === 409 ||
    uploadPayload?.statusCode === "409" ||
    uploadPayload?.code === "KeyAlreadyExists";

  if (
    !uploadResponse.ok &&
    !duplicateObject
  ) {
    throw new Error(
      `Supabase image upload failed (${uploadResponse.status}): ` +
      uploadText.slice(0, 200)
    );
  }

  return (
    `${config.supabaseUrl}/storage/v1/object/public/` +
    `${BUCKET}/${objectPath}`
  );
}

/**
 * Copies a temporary third-party recipe image into durable
 * Simple Dinners storage.
 *
 * Failure is intentionally non-fatal: recipe importing must
 * continue working even when image persistence cannot.
 */
export async function persistImportedRecipeImage(
  imageUrl,
  {
    sourcePageUrl = "",
  } = {}
) {
  const originalUrl = String(imageUrl || "").trim();

  if (!originalUrl || !isHttpUrl(originalUrl)) {
    return originalUrl;
  }

  if (isPersistedImportedRecipeImageUrl(originalUrl)) {
    return originalUrl;
  }

  if (!getStorageConfig()) {
    console.warn(
      "Imported recipe image persistence skipped: Supabase storage is not configured."
    );
    return originalUrl;
  }

  try {
    const {
      buffer,
      mime,
      extension,
    } = await downloadRemoteImage(
      originalUrl,
      sourcePageUrl
    );

    return await uploadImageToStorage(
      buffer,
      mime,
      extension
    );
  } catch (error) {
    console.warn(
      "Imported recipe image persistence failed:",
      safeUrlForLog(originalUrl),
      error instanceof Error
        ? error.message
        : String(error)
    );

    // Never sacrifice a successful recipe import just because
    // its image could not be permanently copied.
    return originalUrl;
  }
}
