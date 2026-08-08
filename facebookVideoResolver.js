import { chromium } from "playwright";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWriteStream,
} from "node:fs";
import {
  Readable,
} from "node:stream";
import {
  pipeline,
} from "node:stream/promises";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;
const DEFAULT_DISCOVERY_WAIT_MS = 3_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 75 * 1024 * 1024;

const FACEBOOK_MEDIA_HOST_SUFFIXES = [
  ".fbcdn.net",
];

function createFacebookResolverError(
  message,
  code
) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireFfmpegPath() {
  if (!ffmpegPath) {
    throw createFacebookResolverError(
      "The bundled FFmpeg binary could not be found.",
      "FACEBOOK_VIDEO_FFMPEG_NOT_FOUND"
    );
  }

  return ffmpegPath;
}

function isFacebookPageHost(host) {
  const value = String(host || "")
    .toLowerCase()
    .replace(/\.$/, "");

  return (
    value === "facebook.com" ||
    value.endsWith(".facebook.com") ||
    value === "fb.watch" ||
    value.endsWith(".fb.watch")
  );
}

function validateFacebookUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(
      String(rawUrl || "").trim()
    );
  } catch {
    throw createFacebookResolverError(
      "Please provide a valid Facebook URL.",
      "INVALID_FACEBOOK_VIDEO_URL"
    );
  }

  if (parsed.protocol !== "https:") {
    throw createFacebookResolverError(
      "Only HTTPS Facebook URLs are supported.",
      "INVALID_FACEBOOK_VIDEO_URL"
    );
  }

  if (
    !isFacebookPageHost(
      parsed.hostname
    )
  ) {
    throw createFacebookResolverError(
      "This resolver supports Facebook links only.",
      "UNSUPPORTED_FACEBOOK_VIDEO_PLATFORM"
    );
  }

  parsed.hash = "";

  return parsed.toString();
}

function isAllowedFacebookMediaUrl(
  rawUrl
) {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.protocol !== "https:") {
      return false;
    }

    const host =
      parsed.hostname.toLowerCase();

    return FACEBOOK_MEDIA_HOST_SUFFIXES.some(
      (suffix) =>
        host.endsWith(suffix) ||
        host === suffix.slice(1)
    );
  } catch {
    return false;
  }
}

function extractEscapedJsonString(
  html,
  field
) {
  const pattern = new RegExp(
    `"${field}":"((?:\\\\.|[^"])*)"`,
    "i"
  );

  const match =
    String(html || "").match(pattern);

  if (!match?.[1]) {
    return "";
  }

  try {
    return JSON.parse(
      `"${match[1]}"`
    );
  } catch {
    return "";
  }
}

function runProcess(
  command,
  args,
  {
    timeoutMs =
      DEFAULT_PROCESS_TIMEOUT_MS,
  } = {}
) {
  return new Promise(
    (resolve, reject) => {
      const child = spawn(
        command,
        args,
        {
          stdio: [
            "ignore",
            "ignore",
            "pipe",
          ],
        }
      );

      let stderr = "";
      let timedOut = false;
      let settled = false;

      function rejectOnce(error) {
        if (settled) return;
        settled = true;
        reject(error);
      }

      function resolveOnce(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }

      child.stderr.on(
        "data",
        (chunk) => {
          if (stderr.length < 80_000) {
            stderr +=
              chunk.toString();
          }
        }
      );

      const timeout =
        setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

      child.on(
        "error",
        (error) => {
          clearTimeout(timeout);
          rejectOnce(error);
        }
      );

      child.on(
        "close",
        (exitCode, signalCode) => {
          clearTimeout(timeout);

          if (timedOut) {
            const error =
              createFacebookResolverError(
                `FFmpeg timed out after ${Math.round(
                  timeoutMs / 1000
                )} seconds.`,
                "FACEBOOK_VIDEO_FFMPEG_TIMEOUT"
              );

            error.stderr = stderr;
            rejectOnce(error);
            return;
          }

          if (exitCode !== 0) {
            const error =
              createFacebookResolverError(
                stderr.trim() ||
                  `FFmpeg exited with code ${exitCode}${
                    signalCode
                      ? ` after signal ${signalCode}`
                      : ""
                  }.`,
                "FACEBOOK_VIDEO_FFMPEG_FAILED"
              );

            error.stderr = stderr;
            error.exitCode =
              exitCode;
            error.signalCode =
              signalCode || null;

            rejectOnce(error);
            return;
          }

          resolveOnce({
            exitCode,
            stderr,
          });
        }
      );
    }
  );
}

async function inspectFacebookPage(
  sourceUrl,
  {
    headless = true,
    navigationTimeoutMs =
      DEFAULT_NAVIGATION_TIMEOUT_MS,
    discoveryWaitMs =
      DEFAULT_DISCOVERY_WAIT_MS,
  } = {}
) {
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36";

  const browser =
    await chromium.launch({
      headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });

  const context =
    await browser.newContext({
      userAgent,
      viewport: {
        width: 1365,
        height: 900,
      },
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language":
          "en-US,en;q=0.9",
      },
    });

  const page =
    await context.newPage();

  try {
    const navigationResponse =
      await page.goto(sourceUrl, {
        waitUntil:
          "domcontentloaded",
        timeout:
          navigationTimeoutMs,
      });

    await page.waitForTimeout(
      discoveryWaitMs
    );

    const finalPageUrl =
      page.url();

    let finalHost = "";

    try {
      finalHost =
        new URL(finalPageUrl)
          .hostname
          .toLowerCase();
    } catch {
      // Handled below.
    }

    if (
      !isFacebookPageHost(finalHost)
    ) {
      throw createFacebookResolverError(
        "Facebook redirected to an unsupported page.",
        "FACEBOOK_VIDEO_REDIRECT_BLOCKED"
      );
    }

    const html =
      await page.content();

    const pageEvidence =
      await page.evaluate(() => {
        const meta = (
          selector
        ) =>
          document
            .querySelector(selector)
            ?.getAttribute(
              "content"
            ) || "";

        const canonical =
          document
            .querySelector(
              'link[rel="canonical"]'
            )
            ?.getAttribute(
              "href"
            ) || "";

        const oEmbedUrl =
          document
            .querySelector(
              'link[rel="alternate"][type="application/json+oembed"]'
            )
            ?.getAttribute(
              "href"
            ) || "";

        return {
          title:
            document.title || "",

          canonicalUrl:
            canonical ||
            meta(
              'meta[property="og:url"]'
            ),

          ogTitle:
            meta(
              'meta[property="og:title"]'
            ),

          description:
            meta(
              'meta[property="og:description"]'
            ) ||
            meta(
              'meta[name="description"]'
            ) ||
            meta(
              'meta[name="twitter:description"]'
            ),

          imageUrl:
            meta(
              'meta[property="og:image"]'
            ) ||
            meta(
              'meta[name="twitter:image"]'
            ),

          oEmbedUrl,
        };
      });

    const sdUrl =
      extractEscapedJsonString(
        html,
        "browser_native_sd_url"
      );

    const hdUrl =
      extractEscapedJsonString(
        html,
        "browser_native_hd_url"
      );

    const selectedMediaUrl =
      isAllowedFacebookMediaUrl(
        sdUrl
      )
        ? sdUrl
        : isAllowedFacebookMediaUrl(
              hdUrl
            )
          ? hdUrl
          : "";

    if (!selectedMediaUrl) {
      const error =
        createFacebookResolverError(
          "Simple Dinners could not access a public video for that Facebook link.",
          "FACEBOOK_VIDEO_NOT_FOUND"
        );

      error.debug = {
        navigationStatus:
          navigationResponse?.status() ??
          null,
        finalPageUrl,
        pageTitle:
          pageEvidence.title,
        canonicalUrl:
          pageEvidence.canonicalUrl,
        sdFound:
          Boolean(sdUrl),
        hdFound:
          Boolean(hdUrl),
      };

      throw error;
    }

    const cookies =
      await context.cookies();

    const cookieHeader =
      cookies
        .filter((cookie) =>
          cookie.domain.includes(
            "facebook.com"
          ) ||
          cookie.domain.includes(
            "fbcdn.net"
          )
        )
        .map(
          (cookie) =>
            `${cookie.name}=${cookie.value}`
        )
        .join("; ");

    return {
      navigationStatus:
        navigationResponse?.status() ??
        null,

      finalPageUrl,

      canonicalUrl:
        pageEvidence.canonicalUrl ||
        finalPageUrl,

      pageTitle:
        pageEvidence.title,

      ogTitle:
        pageEvidence.ogTitle,

      description:
        pageEvidence.description,

      imageUrl:
        pageEvidence.imageUrl,

      oEmbedUrl:
        pageEvidence.oEmbedUrl,

      sdUrl,
      hdUrl,

      selectedMediaUrl,

      selectedQuality:
        selectedMediaUrl === sdUrl
          ? "sd"
          : "hd",

      candidateCount:
        [sdUrl, hdUrl].filter(
          (candidate) =>
            isAllowedFacebookMediaUrl(
              candidate
            )
        ).length,

      cookieHeader,
      userAgent,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function saveFacebookVideoToFile(
  {
    mediaUrl,
    sourceUrl,
    cookieHeader = "",
    userAgent,
    outputPath,
  },
  {
    timeoutMs =
      DEFAULT_PROCESS_TIMEOUT_MS,
  } = {}
) {
  if (
    !isAllowedFacebookMediaUrl(
      mediaUrl
    )
  ) {
    throw createFacebookResolverError(
      "Facebook returned an unsupported media URL.",
      "FACEBOOK_VIDEO_MEDIA_URL_BLOCKED"
    );
  }

  await mkdir(
    path.dirname(outputPath),
    {
      recursive: true,
    }
  );

  const headers = {
    "User-Agent": userAgent,
    Referer: sourceUrl,
  };

  if (cookieHeader) {
    headers.Cookie =
      cookieHeader;
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, timeoutMs);

  try {
    const response =
      await fetch(
        mediaUrl,
        {
          method: "GET",
          headers,
          redirect: "follow",
          signal:
            controller.signal,
        }
      );

    if (!response.ok) {
      throw createFacebookResolverError(
        `Facebook video download returned HTTP ${response.status}.`,
        "FACEBOOK_VIDEO_DOWNLOAD_FAILED"
      );
    }

    if (!response.body) {
      throw createFacebookResolverError(
        "Facebook video download returned an empty response.",
        "FACEBOOK_VIDEO_DOWNLOAD_EMPTY"
      );
    }

    if (
      !isAllowedFacebookMediaUrl(
        response.url
      )
    ) {
      throw createFacebookResolverError(
        "Facebook video download redirected to an unsupported host.",
        "FACEBOOK_VIDEO_MEDIA_REDIRECT_BLOCKED"
      );
    }

    await pipeline(
      Readable.fromWeb(
        response.body
      ),
      createWriteStream(
        outputPath,
        {
          flags: "w",
        }
      )
    );
  } catch (error) {
    await rm(
      outputPath,
      {
        force: true,
      }
    );

    if (
      error?.code &&
      String(error.code).startsWith(
        "FACEBOOK_VIDEO_"
      )
    ) {
      throw error;
    }

    if (
      error?.name ===
      "AbortError"
    ) {
      throw createFacebookResolverError(
        `Facebook video download timed out after ${Math.round(
          timeoutMs / 1000
        )} seconds.`,
        "FACEBOOK_VIDEO_DOWNLOAD_TIMEOUT"
      );
    }

    throw createFacebookResolverError(
      error instanceof Error
        ? `Facebook video download failed: ${error.message}`
        : "Facebook video download failed.",
      "FACEBOOK_VIDEO_DOWNLOAD_FAILED"
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function isSupportedFacebookVideoUrl(
  rawUrl
) {
  try {
    validateFacebookUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

export async function createFacebookVideoResolverWorkspace() {
  return mkdtemp(
    path.join(
      os.tmpdir(),
      "simple-dinners-facebook-video-"
    )
  );
}

export async function cleanupFacebookVideoResolverWorkspace(
  workspaceDir
) {
  if (!workspaceDir) return;

  await rm(workspaceDir, {
    recursive: true,
    force: true,
  });
}

export async function resolveFacebookVideoToFile(
  rawUrl,
  {
    workspaceDir,
    headless = true,
    navigationTimeoutMs =
      DEFAULT_NAVIGATION_TIMEOUT_MS,
    discoveryWaitMs =
      DEFAULT_DISCOVERY_WAIT_MS,
    processTimeoutMs =
      DEFAULT_PROCESS_TIMEOUT_MS,
    maxOutputBytes =
      DEFAULT_MAX_OUTPUT_BYTES,
  } = {}
) {
  const sourceUrl =
    validateFacebookUrl(rawUrl);

  if (!workspaceDir) {
    throw createFacebookResolverError(
      "A Facebook video resolver workspace is required.",
      "FACEBOOK_VIDEO_WORKSPACE_REQUIRED"
    );
  }

  const inspection =
    await inspectFacebookPage(
      sourceUrl,
      {
        headless,
        navigationTimeoutMs,
        discoveryWaitMs,
      }
    );

  const outputPath =
    path.join(
      workspaceDir,
      "resolved-facebook-video.mp4"
    );

  await saveFacebookVideoToFile(
    {
      mediaUrl:
        inspection.selectedMediaUrl,

      sourceUrl,

      cookieHeader:
        inspection.cookieHeader,

      userAgent:
        inspection.userAgent,

      outputPath,
    },
    {
      timeoutMs:
        processTimeoutMs,
    }
  );

  const outputStats =
    await stat(outputPath);

  if (
    !outputStats.isFile() ||
    outputStats.size === 0
  ) {
    throw createFacebookResolverError(
      "The resolved Facebook video was empty.",
      "FACEBOOK_VIDEO_EMPTY"
    );
  }

  if (
    outputStats.size >
    maxOutputBytes
  ) {
    throw createFacebookResolverError(
      "The resolved Facebook video is larger than the supported limit.",
      "FACEBOOK_VIDEO_TOO_LARGE"
    );
  }

  return {
    platform: "facebook",
    sourceUrl,

    canonicalUrl:
      inspection.canonicalUrl,

    outputPath,

    sizeBytes:
      outputStats.size,

    selectedQuality:
      inspection.selectedQuality,

    candidateCount:
      inspection.candidateCount,

    pageTitle:
      inspection.pageTitle,

    ogTitle:
      inspection.ogTitle,

    description:
      inspection.description,

    imageUrl:
      inspection.imageUrl,

    oEmbedUrl:
      inspection.oEmbedUrl,
  };
}
