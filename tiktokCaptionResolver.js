const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

function createTikTokResolverError(
  message,
  code,
  statusCode = 422
) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function cleanHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function isAllowedTikTokHostname(hostname) {
  const cleaned = cleanHostname(hostname);

  return (
    TIKTOK_HOSTS.has(cleaned) ||
    cleaned.endsWith(".tiktok.com")
  );
}

function parseTikTokUrl(value) {
  let parsed;

  try {
    parsed = new URL(
      String(value || "").trim()
    );
  } catch {
    throw createTikTokResolverError(
      "That does not appear to be a valid TikTok URL.",
      "INVALID_TIKTOK_URL",
      400
    );
  }

  if (
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:"
  ) {
    throw createTikTokResolverError(
      "TikTok links must use http or https.",
      "INVALID_TIKTOK_PROTOCOL",
      400
    );
  }

  if (
    !isAllowedTikTokHostname(
      parsed.hostname
    )
  ) {
    throw createTikTokResolverError(
      "Only TikTok links are supported by this resolver.",
      "UNSUPPORTED_TIKTOK_HOST",
      400
    );
  }

  return parsed;
}

function normalizeDirectTikTokUrl(value) {
  const parsed = parseTikTokUrl(value);

  const directVideoMatch =
    parsed.pathname.match(
      /^\/@([^/]+)\/video\/(\d+)\/?$/
    );

  if (!directVideoMatch) {
    parsed.hash = "";
    return parsed.toString();
  }

  const [, username, videoId] =
    directVideoMatch;

  return (
    `https://www.tiktok.com/` +
    `@${username}/video/${videoId}`
  );
}

function extractCanonicalUrlFromHtml(html) {
  const source = String(html || "");

  const citeMatch = source.match(
    /\bcite=(["'])(https?:\/\/www\.tiktok\.com\/@[^"'<>]+\/video\/\d+)\1/i
  );

  if (citeMatch?.[2]) {
    return normalizeDirectTikTokUrl(
      citeMatch[2]
    );
  }

  const hrefMatch = source.match(
    /https?:\/\/www\.tiktok\.com\/@[^"'<>?\s]+\/video\/\d+/i
  );

  if (hrefMatch?.[0]) {
    return normalizeDirectTikTokUrl(
      hrefMatch[0]
    );
  }

  return "";
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to do. The redirect URL has already been captured.
  }
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 20000
) {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createTikTokResolverError(
        "TikTok took too long to respond.",
        "TIKTOK_TIMEOUT",
        504
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function expandTikTokUrl(
  sourceUrl
) {
  const parsed =
    parseTikTokUrl(sourceUrl);

  const alreadyDirect =
    /^\/@[^/]+\/video\/\d+\/?$/.test(
      parsed.pathname
    );

  if (alreadyDirect) {
    return normalizeDirectTikTokUrl(
      parsed.toString()
    );
  }

  const response =
    await fetchWithTimeout(
      parsed.toString(),
      {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent":
            DEFAULT_USER_AGENT,
          accept:
            "text/html,application/xhtml+xml",
        },
      }
    );

  const expandedUrl =
    response.url ||
    parsed.toString();

  await cancelResponseBody(response);

  const expanded =
    parseTikTokUrl(expandedUrl);

  return normalizeDirectTikTokUrl(
    expanded.toString()
  );
}

async function fetchTikTokOEmbed(
  videoUrl
) {
  const endpoint = new URL(
    "https://www.tiktok.com/oembed"
  );

  endpoint.searchParams.set(
    "url",
    videoUrl
  );

  const response =
    await fetchWithTimeout(
      endpoint.toString(),
      {
        headers: {
          "user-agent":
            DEFAULT_USER_AGENT,
          accept: "application/json",
        },
      }
    );

  if (!response.ok) {
    throw createTikTokResolverError(
      `TikTok oEmbed returned HTTP ${response.status}.`,
      "TIKTOK_OEMBED_FAILED",
      response.status
    );
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw createTikTokResolverError(
      "TikTok returned an unreadable oEmbed response.",
      "INVALID_TIKTOK_OEMBED",
      502
    );
  }

  return payload;
}

export async function resolveTikTokCaption(
  sourceUrl
) {
  const originalUrl =
    parseTikTokUrl(
      sourceUrl
    ).toString();

  const expandedUrl =
    await expandTikTokUrl(
      originalUrl
    );

  const oembed =
    await fetchTikTokOEmbed(
      expandedUrl
    );

  const canonicalFromHtml =
    extractCanonicalUrlFromHtml(
      oembed?.html
    );

  const canonicalUrl =
    canonicalFromHtml ||
    normalizeDirectTikTokUrl(
      expandedUrl
    );

  const captionText =
    String(
      oembed?.title || ""
    ).trim();

  if (!captionText) {
    throw createTikTokResolverError(
      "TikTok did not provide a usable caption for that public video.",
      "TIKTOK_CAPTION_UNAVAILABLE",
      422
    );
  }

  return {
    success: true,
    platform: "tiktok",

    originalUrl,
    expandedUrl,
    sourceUrl: canonicalUrl,

    captionText,
    captionSource:
      "tiktok-oembed-title",

    title: captionText,

    imageUrl:
      String(
        oembed?.thumbnail_url || ""
      ).trim(),

    imageWidth:
      Number(
        oembed?.thumbnail_width || 0
      ),

    imageHeight:
      Number(
        oembed?.thumbnail_height || 0
      ),

    authorName:
      String(
        oembed?.author_name || ""
      ).trim(),

    authorUrl:
      String(
        oembed?.author_url || ""
      ).trim(),

    authorUniqueId:
      String(
        oembed?.author_unique_id || ""
      ).trim(),

    videoId:
      String(
        oembed?.embed_product_id || ""
      ).trim(),

    providerName:
      String(
        oembed?.provider_name || "TikTok"
      ).trim(),

    embedType:
      String(
        oembed?.embed_type ||
        oembed?.type ||
        "video"
      ).trim(),

    oembedVersion:
      String(
        oembed?.version || ""
      ).trim(),
  };
}
