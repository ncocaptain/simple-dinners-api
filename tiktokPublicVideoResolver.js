import {
  createWriteStream,
} from "node:fs";

import {
  mkdir,
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  pipeline,
} from "node:stream/promises";

import {
  Readable,
} from "node:stream";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Safari/537.36";

const MAX_OUTPUT_BYTES =
  75 * 1024 * 1024;

function createResolverError(
  message,
  code,
  statusCode = 422
) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validateTikTokUrl(
  value
) {
  let parsed;

  try {
    parsed =
      new URL(
        String(value || "")
          .trim()
      );
  } catch {
    throw createResolverError(
      "That does not appear to be a valid TikTok URL.",
      "INVALID_TIKTOK_URL",
      400
    );
  }

  const host =
    parsed.hostname
      .toLowerCase()
      .replace(/\.$/, "");

  if (
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:"
  ) {
    throw createResolverError(
      "TikTok links must use http or https.",
      "INVALID_TIKTOK_PROTOCOL",
      400
    );
  }

  if (
    host !== "tiktok.com" &&
    !host.endsWith(
      ".tiktok.com"
    )
  ) {
    throw createResolverError(
      "Only TikTok links are supported by this resolver.",
      "UNSUPPORTED_TIKTOK_HOST",
      400
    );
  }

  return parsed.toString();
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 20_000
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal,
      }
    );
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw createResolverError(
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

function buildCookieHeader(
  response
) {
  const values =
    typeof response.headers
      .getSetCookie ===
    "function"
      ? response.headers
          .getSetCookie()
      : [];

  return values
    .map(
      (value) =>
        value.split(";")[0]
    )
    .filter(Boolean)
    .join("; ");
}

function extractJsonScript(
  html,
  id
) {
  const match =
    String(html || "")
      .match(
        new RegExp(
          `<script[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`,
          "i"
        )
      );

  if (!match?.[1]) {
    return null;
  }

  try {
    return JSON.parse(
      match[1]
        .replace(
          /&quot;/g,
          '"'
        )
        .replace(
          /&amp;/g,
          "&"
        )
        .replace(
          /&#39;/g,
          "'"
        )
        .trim()
    );
  } catch {
    return null;
  }
}

function cleanMediaUrl(
  value
) {
  return String(value || "")
    .trim()
    .replace(
      /\\u002F/gi,
      "/"
    )
    .replace(
      /\\u0026/gi,
      "&"
    )
    .replace(
      /\\u003D/gi,
      "="
    )
    .replace(
      /\\\//g,
      "/"
    )
    .replace(
      /&amp;/g,
      "&"
    );
}

function collectCandidates(
  root
) {
  const found =
    new Map();

  const keys =
    new Set([
      "playAddr",
      "downloadAddr",
      "playApi",
      "playAddrH264",
      "playAddrBytevc1",
      "urlList",
      "UrlList",
    ]);

  let visited = 0;

  function add(
    value,
    source
  ) {
    if (
      typeof value !==
      "string"
    ) {
      return;
    }

    const url =
      cleanMediaUrl(
        value
      );

    if (
      !/^https?:\/\//i.test(
        url
      )
    ) {
      return;
    }

    if (!found.has(url)) {
      found.set(
        url,
        {
          url,
          sources: [],
        }
      );
    }

    const item =
      found.get(url);

    if (
      !item.sources.includes(
        source
      )
    ) {
      item.sources.push(
        source
      );
    }
  }

  function walk(
    value,
    currentPath = "root",
    depth = 0
  ) {
    if (
      value == null ||
      depth > 30 ||
      visited > 100_000
    ) {
      return;
    }

    if (
      Array.isArray(value)
    ) {
      visited++;

      value.forEach(
        (item, index) =>
          walk(
            item,
            `${currentPath}[${index}]`,
            depth + 1
          )
      );

      return;
    }

    if (
      typeof value !==
      "object"
    ) {
      return;
    }

    visited++;

    for (
      const [
        key,
        child,
      ] of Object.entries(
        value
      )
    ) {
      const childPath =
        `${currentPath}.${key}`;

      if (
        keys.has(key)
      ) {
        if (
          typeof child ===
          "string"
        ) {
          add(
            child,
            childPath
          );
        } else if (
          Array.isArray(child)
        ) {
          child.forEach(
            (item) =>
              add(
                item,
                childPath
              )
          );
        }
      }

      walk(
        child,
        childPath,
        depth + 1
      );
    }
  }

  walk(root);

  return Array.from(
    found.values()
  );
}

function collectRawCandidates(
  html
) {
  const found =
    new Map();

  const pattern =
    /"(?:playAddr|downloadAddr|playApi|playAddrH264)"\s*:\s*"((?:\\.|[^"\\])*)"/gi;

  let match;
  let count = 0;

  while (
    (match =
      pattern.exec(html)) &&
    count < 100
  ) {
    count++;

    let value =
      match[1];

    try {
      value =
        JSON.parse(
          `"${value}"`
        );
    } catch {
      // Use captured text.
    }

    const url =
      cleanMediaUrl(
        value
      );

    if (
      /^https?:\/\//i.test(
        url
      )
    ) {
      found.set(
        url,
        {
          url,
          sources: [
            "raw-html",
          ],
        }
      );
    }
  }

  return Array.from(
    found.values()
  );
}

function scoreCandidate(
  candidate
) {
  const source =
    candidate.sources.join(
      " "
    );

  let score = 0;

  if (
    /\.playAddr\b/i.test(
      source
    )
  ) {
    score += 100;
  }

  if (
    /PlayAddrStruct/i.test(
      source
    )
  ) {
    score += 80;
  }

  if (
    /bitrateInfo/i.test(
      source
    )
  ) {
    score += 60;
  }

  if (
    /h264/i.test(
      source
    )
  ) {
    score += 20;
  }

  if (
    /downloadAddr/i.test(
      source
    )
  ) {
    score += 10;
  }

  if (
    /bytevc1/i.test(
      source
    )
  ) {
    score -= 30;
  }

  return score;
}

function mediaHeaders({
  referer,
  cookieHeader,
  range = "",
}) {
  const headers = {
    "User-Agent":
      USER_AGENT,
    Referer:
      referer,
    Accept:
      "*/*",
  };

  if (cookieHeader) {
    headers.Cookie =
      cookieHeader;
  }

  if (range) {
    headers.Range =
      range;
  }

  return headers;
}

async function candidateWorks(
  candidate,
  context
) {
  const response =
    await fetchWithTimeout(
      candidate.url,
      {
        headers:
          mediaHeaders({
            ...context,
            range:
              "bytes=0-1024",
          }),
        redirect:
          "follow",
      },
      12_000
    );

  try {
    const type =
      String(
        response.headers.get(
          "content-type"
        ) || ""
      ).toLowerCase();

    return (
      response.ok &&
      type.startsWith(
        "video/"
      )
    );
  } finally {
    try {
      await response.body?.cancel();
    } catch {
      // No-op.
    }
  }
}

async function downloadCandidate(
  candidate,
  {
    referer,
    cookieHeader,
    outputPath,
    maxOutputBytes,
  }
) {
  const response =
    await fetchWithTimeout(
      candidate.url,
      {
        headers:
          mediaHeaders({
            referer,
            cookieHeader,
          }),
        redirect:
          "follow",
      },
      30_000
    );

  if (!response.ok) {
    throw createResolverError(
      `TikTok video returned HTTP ${response.status}.`,
      "TIKTOK_VIDEO_DOWNLOAD_FAILED",
      502
    );
  }

  const type =
    String(
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

  if (
    !type.startsWith(
      "video/"
    )
  ) {
    throw createResolverError(
      "TikTok did not return a video stream.",
      "TIKTOK_WRONG_MEDIA_TYPE",
      502
    );
  }

  const length =
    Number(
      response.headers.get(
        "content-length"
      ) || 0
    );

  if (
    length > 0 &&
    length >
      maxOutputBytes
  ) {
    throw createResolverError(
      "The TikTok video is larger than the supported limit.",
      "PUBLIC_VIDEO_TOO_LARGE",
      413
    );
  }

  if (!response.body) {
    throw createResolverError(
      "TikTok returned an empty video response.",
      "TIKTOK_VIDEO_EMPTY",
      502
    );
  }

  await mkdir(
    path.dirname(
      outputPath
    ),
    {
      recursive: true,
    }
  );

  await pipeline(
    Readable.fromWeb(
      response.body
    ),
    createWriteStream(
      outputPath
    )
  );

  const stats =
    await stat(
      outputPath
    );

  if (
    !stats.isFile() ||
    stats.size === 0
  ) {
    throw createResolverError(
      "The resolved TikTok video was empty.",
      "TIKTOK_VIDEO_EMPTY",
      502
    );
  }

  if (
    stats.size >
    maxOutputBytes
  ) {
    throw createResolverError(
      "The TikTok video is larger than the supported limit.",
      "PUBLIC_VIDEO_TOO_LARGE",
      413
    );
  }

  return stats;
}

export async function createTikTokVideoResolverWorkspace() {
  return mkdtemp(
    path.join(
      os.tmpdir(),
      "simple-dinners-tiktok-video-"
    )
  );
}

export async function cleanupTikTokVideoResolverWorkspace(
  workspaceDir
) {
  if (!workspaceDir) return;

  await rm(
    workspaceDir,
    {
      recursive: true,
      force: true,
    }
  );
}

export async function resolveTikTokVideoToFile(
  rawUrl,
  {
    workspaceDir,
    maxOutputBytes =
      MAX_OUTPUT_BYTES,
  } = {}
) {
  const sourceUrl =
    validateTikTokUrl(
      rawUrl
    );

  if (!workspaceDir) {
    throw createResolverError(
      "A TikTok resolver workspace is required.",
      "TIKTOK_VIDEO_WORKSPACE_REQUIRED",
      500
    );
  }

  const pageResponse =
    await fetchWithTimeout(
      sourceUrl,
      {
        headers: {
          "User-Agent":
            USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language":
            "en-US,en;q=0.9",
          "Sec-Fetch-Dest":
            "document",
          "Sec-Fetch-Mode":
            "navigate",
          "Sec-Fetch-Site":
            "none",
        },
        redirect:
          "follow",
      }
    );

  if (!pageResponse.ok) {
    throw createResolverError(
      `TikTok page returned HTTP ${pageResponse.status}.`,
      "TIKTOK_VIDEO_PAGE_FAILED",
      502
    );
  }

  const referer =
    pageResponse.url ||
    sourceUrl;

  const cookieHeader =
    buildCookieHeader(
      pageResponse
    );

  const html =
    await pageResponse.text();

  const universal =
    extractJsonScript(
      html,
      "__UNIVERSAL_DATA_FOR_REHYDRATION__"
    );

  const sigi =
    extractJsonScript(
      html,
      "SIGI_STATE"
    );

  const all = [
    ...collectCandidates(
      universal
    ),
    ...collectCandidates(
      sigi
    ),
    ...collectRawCandidates(
      html
    ),
  ];

  const unique =
    new Map();

  for (
    const candidate of all
  ) {
    const existing =
      unique.get(
        candidate.url
      );

    if (existing) {
      existing.sources =
        Array.from(
          new Set([
            ...existing.sources,
            ...candidate.sources,
          ])
        );
    } else {
      unique.set(
        candidate.url,
        candidate
      );
    }
  }

  const ranked =
    Array.from(
      unique.values()
    ).sort(
      (a, b) =>
        scoreCandidate(b) -
        scoreCandidate(a)
    );

  let selected = null;

  for (
    const candidate of
      ranked.slice(0, 12)
  ) {
    try {
      const works =
        await candidateWorks(
          candidate,
          {
            referer,
            cookieHeader,
          }
        );

      if (works) {
        selected =
          candidate;
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }

  if (!selected) {
    throw createResolverError(
      "Simple Dinners could not access a public TikTok video stream.",
      "TIKTOK_VIDEO_NOT_FOUND",
      422
    );
  }

  const outputPath =
    path.join(
      workspaceDir,
      "resolved-tiktok-video.mp4"
    );

  const stats =
    await downloadCandidate(
      selected,
      {
        referer,
        cookieHeader,
        outputPath,
        maxOutputBytes,
      }
    );

  console.log(
    "TikTok public video resolver succeeded:",
    {
      sizeBytes:
        stats.size,
      candidateCount:
        ranked.length,
    }
  );

  return {
    platform:
      "tiktok",
    sourceUrl:
      referer,
    outputPath,
    sizeBytes:
      stats.size,
    candidateCount:
      ranked.length,
    resolver:
      "public-page",
  };
}
