import { chromium } from "playwright";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
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

const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;
const DEFAULT_DISCOVERY_WAIT_MS = 6_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 75 * 1024 * 1024;

const INSTAGRAM_PAGE_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
]);

const INSTAGRAM_MEDIA_HOST_SUFFIXES = [
  ".cdninstagram.com",
  ".fbcdn.net",
];

function createResolverError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireFfmpegPath() {
  if (!ffmpegPath) {
    throw createResolverError(
      "The bundled FFmpeg binary could not be found.",
      "FFMPEG_NOT_FOUND"
    );
  }

  return ffmpegPath;
}

function validateInstagramUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw createResolverError(
      "Please provide a valid Instagram reel URL.",
      "INVALID_PUBLIC_VIDEO_URL"
    );
  }

  if (parsed.protocol !== "https:") {
    throw createResolverError(
      "Only HTTPS Instagram URLs are supported.",
      "INVALID_PUBLIC_VIDEO_URL"
    );
  }

  const host = parsed.hostname.toLowerCase();

  if (!INSTAGRAM_PAGE_HOSTS.has(host)) {
    throw createResolverError(
      "This resolver currently supports Instagram links only.",
      "UNSUPPORTED_PUBLIC_VIDEO_PLATFORM"
    );
  }

  if (!/^\/(reel|reels|p)\//i.test(parsed.pathname)) {
    throw createResolverError(
      "Please provide an Instagram reel or post URL.",
      "UNSUPPORTED_INSTAGRAM_PATH"
    );
  }

  parsed.hash = "";

  return parsed.toString();
}

function isAllowedInstagramMediaUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.protocol !== "https:") {
      return false;
    }

    const host = parsed.hostname.toLowerCase();

    return INSTAGRAM_MEDIA_HOST_SUFFIXES.some(
      (suffix) =>
        host.endsWith(suffix) ||
        host === suffix.slice(1)
    );
  } catch {
    return false;
  }
}

function cleanCandidateUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function looksLikeVideoUrl(candidateUrl, contentType = "") {
  const url = String(candidateUrl || "");
  const type = String(contentType || "").toLowerCase();

  return (
    type.startsWith("video/") ||
    type.includes("mpegurl") ||
    /\.(mp4|m4v|mov|webm|m3u8)(?:[?#]|$)/i.test(url) ||
    /\/video\/|video_dashinit|videoplayback/i.test(url)
  );
}

function removeByteRangeParameters(rawUrl) {
  const parsed = new URL(rawUrl);

  parsed.searchParams.delete("bytestart");
  parsed.searchParams.delete("byteend");

  return parsed.toString();
}

function decodeBase64Json(value) {
  try {
    const normalized = String(value || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const decoded = Buffer.from(
      normalized,
      "base64"
    ).toString("utf8");

    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function readInstagramEncodingMetadata(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const encoded = parsed.searchParams.get("efg");

    if (!encoded) {
      return null;
    }

    return decodeBase64Json(encoded);
  } catch {
    return null;
  }
}

function classifyInstagramMedia(rawUrl) {
  const metadata =
    readInstagramEncodingMetadata(rawUrl);

  const encodingTag = String(
    metadata?.vencode_tag || ""
  ).toLowerCase();

  return {
    kind: encodingTag.includes("audio")
      ? "audio"
      : "video",

    bitrate: Number(
      metadata?.bitrate || 0
    ),

    durationSeconds: Number(
      metadata?.duration_s || 0
    ),

    encodingTag,
  };
}

const INSTAGRAM_BROWSER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Safari/537.36";

function getInstagramShortcode(rawUrl) {
  try {
    const parsed = new URL(rawUrl);

    return (
      parsed.pathname.match(
        /^\/(?:reel|reels|p)\/([^/?#]+)/
      )?.[1] || ""
    );
  } catch {
    return "";
  }
}

function extractBalancedJson(
  text,
  start
) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (
    let i = start;
    i < text.length;
    i++
  ) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;

      if (depth === 0) {
        return text.slice(
          start,
          i + 1
        );
      }
    }
  }

  return null;
}

function extractInstagramEmbedMedia(html) {
  const contextKey =
    '"contextJSON":';

  let searchFrom = 0;

  while (true) {
    const index =
      html.indexOf(
        contextKey,
        searchFrom
      );

    if (index === -1) {
      break;
    }

    const quoteStart =
      html.indexOf(
        '"',
        index +
          contextKey.length
      );

    if (quoteStart === -1) {
      break;
    }

    let i =
      quoteStart + 1;
    let escaped = false;

    for (
      ;
      i < html.length;
      i++
    ) {
      const ch = html[i];

      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        break;
      }
    }

    searchFrom = i + 1;

    const token =
      html.slice(
        quoteStart,
        i + 1
      );

    try {
      const inner =
        JSON.parse(token);

      const payload =
        JSON.parse(inner);

      const media =
        payload?.gql_data
          ?.shortcode_media ||
        payload?.context
          ?.media;

      if (media) {
        return media;
      }
    } catch {
      // Try the next contextJSON blob.
    }
  }

  const rawKey =
    '"shortcode_media":';

  const rawIndex =
    html.indexOf(rawKey);

  if (rawIndex !== -1) {
    const braceStart =
      html.indexOf(
        "{",
        rawIndex +
          rawKey.length
      );

    if (braceStart !== -1) {
      const raw =
        extractBalancedJson(
          html,
          braceStart
        );

      if (raw) {
        try {
          return JSON.parse(raw);
        } catch {
          // Ignore malformed fallback.
        }
      }
    }
  }

  return null;
}

function instagramEmbedContainsVideo(media) {
  if (media?.is_video) {
    return true;
  }

  return Boolean(
    media
      ?.edge_sidecar_to_children
      ?.edges
      ?.some(
        (edge) =>
          edge?.node?.is_video
      )
  );
}

function getInstagramEmbedVideoUrl(media) {
  if (media?.video_url) {
    return media.video_url;
  }

  const videoChild =
    media
      ?.edge_sidecar_to_children
      ?.edges
      ?.map(
        (edge) =>
          edge?.node
      )
      ?.find(
        (node) =>
          node?.is_video &&
          node?.video_url
      );

  return (
    videoChild?.video_url ||
    ""
  );
}

function getInstagramEmbedCaption(media) {
  return String(
    media
      ?.edge_media_to_caption
      ?.edges?.[0]
      ?.node?.text ||
      ""
  ).trim();
}

async function inspectDownloadedMedia(
  filePath,
  {
    timeoutMs =
      20_000,
  } = {}
) {
  const result =
    await runProcess(
      requireFfmpegPath(),
      [
        "-hide_banner",
        "-i",
        filePath,
        "-t",
        "0.25",
        "-f",
        "null",
        "-",
      ],
      {
        timeoutMs,
      }
    );

  return {
    hasVideo:
      /Stream #.*Video:/i.test(
        result.stderr
      ),

    hasAudio:
      /Stream #.*Audio:/i.test(
        result.stderr
      ),

    videoCodec:
      result.stderr.match(
        /Stream #.*Video:\s*([^,\s]+)/i
      )?.[1] || "",

    audioCodec:
      result.stderr.match(
        /Stream #.*Audio:\s*([^,\s]+)/i
      )?.[1] || "",
  };
}

async function downloadPublicInstagramVideo(
  mediaUrl,
  {
    sourceUrl,
    outputPath,
    maxOutputBytes,
  }
) {
  const response =
    await fetch(
      mediaUrl,
      {
        headers: {
          "User-Agent":
            INSTAGRAM_BROWSER_AGENT,
          Referer:
            sourceUrl,
        },
        redirect:
          "follow",
      }
    );

  if (!response.ok) {
    throw createResolverError(
      `Instagram public video answered ${response.status}.`,
      "PUBLIC_INSTAGRAM_DOWNLOAD_FAILED"
    );
  }

  const contentType =
    String(
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

  if (
    !contentType.startsWith(
      "video/"
    )
  ) {
    throw createResolverError(
      `Instagram returned ${contentType || "an unknown content type"} instead of video.`,
      "PUBLIC_INSTAGRAM_WRONG_MEDIA_TYPE"
    );
  }

  const contentLength =
    Number(
      response.headers.get(
        "content-length"
      ) || 0
    );

  if (
    contentLength > 0 &&
    contentLength >
      maxOutputBytes
  ) {
    throw createResolverError(
      "The resolved Instagram video is larger than the supported limit.",
      "PUBLIC_VIDEO_TOO_LARGE"
    );
  }

  if (!response.body) {
    throw createResolverError(
      "Instagram returned an empty video response.",
      "PUBLIC_VIDEO_EMPTY"
    );
  }

  await mkdir(
    path.dirname(outputPath),
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

  const outputStats =
    await stat(outputPath);

  if (
    !outputStats.isFile() ||
    outputStats.size === 0
  ) {
    throw createResolverError(
      "The resolved Instagram video was empty.",
      "PUBLIC_VIDEO_EMPTY"
    );
  }

  if (
    outputStats.size >
    maxOutputBytes
  ) {
    throw createResolverError(
      "The resolved Instagram video is larger than the supported limit.",
      "PUBLIC_VIDEO_TOO_LARGE"
    );
  }

  return outputStats;
}

async function tryResolveInstagramPublicEmbed(
  sourceUrl,
  {
    workspaceDir,
    processTimeoutMs,
    maxOutputBytes,
  }
) {
  const shortcode =
    getInstagramShortcode(
      sourceUrl
    );

  if (!shortcode) {
    return null;
  }

  const embedUrl =
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      12_000
    );

  let response;

  try {
    response =
      await fetch(
        embedUrl,
        {
          headers: {
            "User-Agent":
              INSTAGRAM_BROWSER_AGENT,
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
          signal:
            controller.signal,
        }
      );
  } catch (error) {
    console.warn(
      "Instagram public embed preflight failed:",
      error instanceof Error
        ? error.message
        : String(error)
    );

    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return null;
  }

  const html =
    await response.text();

  if (!html) {
    return null;
  }

  const declaredType =
    html.match(
      /data-media-type="([^"]+)"/
    )?.[1] || "";

  const media =
    extractInstagramEmbedMedia(
      html
    );

  if (!media) {
    return null;
  }

  const containsVideo =
    instagramEmbedContainsVideo(
      media
    );

  // A normal image/carousel post should fall through to
  // the regular recipe importer immediately instead of
  // paying the Chromium video-resolution cost.
  if (
    !containsVideo &&
    declaredType !==
      "GraphVideo"
  ) {
    const error =
      createResolverError(
        "That Instagram post does not contain a public video.",
        "PUBLIC_INSTAGRAM_NOT_VIDEO"
      );

    error.skipBrowserFallback =
      true;

    error.publicEmbed = {
      declaredType,
      captionLength:
        getInstagramEmbedCaption(
          media
        ).length,
    };

    throw error;
  }

  const mediaUrl =
    getInstagramEmbedVideoUrl(
      media
    );

  if (!mediaUrl) {
    return null;
  }

  if (
    !isAllowedInstagramMediaUrl(
      mediaUrl
    )
  ) {
    return null;
  }

  const outputPath =
    path.join(
      workspaceDir,
      "resolved-instagram-video.mp4"
    );

  try {
    const outputStats =
      await downloadPublicInstagramVideo(
        mediaUrl,
        {
          sourceUrl,
          outputPath,
          maxOutputBytes,
        }
      );

    const streamInfo =
      await inspectDownloadedMedia(
        outputPath,
        {
          timeoutMs:
            Math.min(
              processTimeoutMs,
              20_000
            ),
        }
      );

    if (
      !streamInfo.hasVideo
    ) {
      await rm(
        outputPath,
        {
          force: true,
        }
      );

      return null;
    }

    // If the public embed gave us a video-only rendition,
    // let the existing browser resolver look for a separate
    // audio track rather than silently losing spoken recipe
    // instructions.
    if (
      !streamInfo.hasAudio
    ) {
      await rm(
        outputPath,
        {
          force: true,
        }
      );

      return null;
    }

    const classification =
      classifyInstagramMedia(
        mediaUrl
      );

    return {
      platform:
        "instagram",
      sourceUrl,
      outputPath,
      sizeBytes:
        outputStats.size,
      hasAudio: true,
      durationSeconds:
        Number(
          classification
            .durationSeconds ||
          media?.video_duration ||
          0
        ),
      candidateCount: 1,
      uniqueTrackCount: 1,
      videoTrack: {
        bitrate:
          classification.bitrate,
        encodingTag:
          classification.encodingTag,
      },
      audioTrack: {
        bitrate: 0,
        encodingTag:
          streamInfo.audioCodec ||
          "muxed",
      },
      resolver:
        "public-embed",
      publicEmbed: {
        declaredType,
        captionLength:
          getInstagramEmbedCaption(
            media
          ).length,
        videoCodec:
          streamInfo.videoCodec,
        audioCodec:
          streamInfo.audioCodec,
      },
    };
  } catch (error) {
    console.warn(
      "Instagram public embed video path failed; falling back to browser resolver:",
      error instanceof Error
        ? error.message
        : String(error)
    );

    try {
      await rm(
        outputPath,
        {
          force: true,
        }
      );
    } catch {
      // Ignore cleanup failure.
    }

    return null;
  }
}

function runProcess(
  command,
  args,
  {
    timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

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

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 80_000) {
        stderr += chunk.toString();
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectOnce(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);

      if (timedOut) {
        const error = createResolverError(
          `FFmpeg timed out after ${Math.round(
            timeoutMs / 1000
          )} seconds.`,
          "PUBLIC_VIDEO_FFMPEG_TIMEOUT"
        );

        error.stderr = stderr;
        rejectOnce(error);
        return;
      }

      if (exitCode !== 0) {
        const error = createResolverError(
          stderr.trim() ||
            `FFmpeg exited with code ${exitCode}.`,
          "PUBLIC_VIDEO_FFMPEG_FAILED"
        );

        error.stderr = stderr;
        error.exitCode = exitCode;
        rejectOnce(error);
        return;
      }

      resolveOnce({
        exitCode,
        stderr,
      });
    });
  });
}

function addCandidateToMap(
  candidates,
  {
    url,
    source,
    contentType = "",
    status = null,
  }
) {
  const cleanedUrl = cleanCandidateUrl(url);

  if (
    !cleanedUrl ||
    cleanedUrl.startsWith("blob:") ||
    cleanedUrl.startsWith("data:")
  ) {
    return;
  }

  if (
    !looksLikeVideoUrl(
      cleanedUrl,
      contentType
    ) ||
    !isAllowedInstagramMediaUrl(cleanedUrl)
  ) {
    return;
  }

  const existing = candidates.get(cleanedUrl);

  if (existing) {
    existing.sources = Array.from(
      new Set([
        ...existing.sources,
        source,
      ])
    );

    if (
      !existing.contentType &&
      contentType
    ) {
      existing.contentType =
        contentType;
    }

    if (
      existing.status == null &&
      status != null
    ) {
      existing.status = status;
    }

    return;
  }

  candidates.set(cleanedUrl, {
    url: cleanedUrl,
    sources: [source],
    contentType,
    status,
  });
}

function selectInstagramMediaTracks(candidateList) {
  const uniqueMedia = new Map();

  for (const candidate of candidateList) {
    let normalizedUrl;

    try {
      normalizedUrl =
        removeByteRangeParameters(
          candidate.url
        );
    } catch {
      continue;
    }

    if (!isAllowedInstagramMediaUrl(normalizedUrl)) {
      continue;
    }

    const classification =
      classifyInstagramMedia(
        normalizedUrl
      );

    const existing =
      uniqueMedia.get(normalizedUrl);

    if (existing) {
      existing.sources = Array.from(
        new Set([
          ...existing.sources,
          ...candidate.sources,
        ])
      );

      continue;
    }

    uniqueMedia.set(normalizedUrl, {
      ...candidate,
      url: normalizedUrl,
      ...classification,
    });
  }

  const mediaTracks = Array.from(
    uniqueMedia.values()
  );

  const videoTracks = mediaTracks
    .filter(
      (candidate) =>
        candidate.kind === "video"
    )
    .sort(
      (a, b) =>
        b.bitrate - a.bitrate
    );

  const audioTracks = mediaTracks
    .filter(
      (candidate) =>
        candidate.kind === "audio"
    )
    .sort(
      (a, b) =>
        b.bitrate - a.bitrate
    );

  return {
    videoTrack:
      videoTracks[0] || null,

    audioTrack:
      audioTracks[0] || null,

    mediaTracks,
  };
}

async function inspectInstagramPage(
  sourceUrl,
  {
    headless = true,
    navigationTimeoutMs =
      DEFAULT_NAVIGATION_TIMEOUT_MS,
    discoveryWaitMs =
      DEFAULT_DISCOVERY_WAIT_MS,
  } = {}
) {
  const browser = await chromium.launch({
    headless,
  });

  const context = await browser.newContext({
    viewport: {
      width: 1280,
      height: 900,
    },
    locale: "en-US",
  });

  const page = await context.newPage();
  const candidates = new Map();

  page.on("response", (response) => {
    try {
      const responseUrl =
        response.url();

      const headers =
        response.headers();

      addCandidateToMap(candidates, {
        url: responseUrl,
        source: "network-response",
        contentType:
          headers["content-type"] || "",
        status: response.status(),
      });
    } catch {
      // Ignore individual response inspection errors.
    }
  });

  page.on("request", (request) => {
    try {
      addCandidateToMap(candidates, {
        url: request.url(),
        source: "network-request",
      });
    } catch {
      // Ignore individual request inspection errors.
    }
  });

  try {
    const navigationResponse =
      await page.goto(sourceUrl, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs,
      });

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

    if (!INSTAGRAM_PAGE_HOSTS.has(finalHost)) {
      throw createResolverError(
        "Instagram redirected to an unsupported page.",
        "PUBLIC_VIDEO_REDIRECT_BLOCKED"
      );
    }

    await page.waitForTimeout(
      discoveryWaitMs
    );

    const pageEvidence =
      await page.evaluate(() => {
        const values = [];

        const addValue = (
          url,
          source,
          contentType = ""
        ) => {
          if (!url) return;

          values.push({
            url,
            source,
            contentType,
          });
        };

        const metaSelectors = [
          [
            'meta[property="og:video"]',
            "og:video",
          ],
          [
            'meta[property="og:video:url"]',
            "og:video:url",
          ],
          [
            'meta[property="og:video:secure_url"]',
            "og:video:secure_url",
          ],
          [
            'meta[name="twitter:player:stream"]',
            "twitter:player:stream",
          ],
        ];

        for (const [
          selector,
          source,
        ] of metaSelectors) {
          const element =
            document.querySelector(
              selector
            );

          addValue(
            element?.getAttribute(
              "content"
            ),
            source
          );
        }

        const videoElements =
          Array.from(
            document.querySelectorAll(
              "video"
            )
          );

        videoElements.forEach(
          (video, videoIndex) => {
            addValue(
              video.currentSrc,
              `video-${videoIndex + 1}-currentSrc`
            );

            addValue(
              video.src,
              `video-${videoIndex + 1}-src`
            );

            Array.from(
              video.querySelectorAll(
                "source"
              )
            ).forEach(
              (
                sourceElement,
                sourceIndex
              ) => {
                addValue(
                  sourceElement.src,
                  `video-${videoIndex + 1}-source-${sourceIndex + 1}`,
                  sourceElement.type
                );
              }
            );
          }
        );

        for (
          const script of Array.from(
            document.scripts
          )
        ) {
          const content =
            script.textContent || "";

          if (
            content.length === 0 ||
            content.length >
              3_000_000 ||
            !/video_url|video_versions|\.mp4|\.m3u8/i.test(
              content
            )
          ) {
            continue;
          }

          const matches =
            content.match(
              /https?:\\?\/\\?\/[^"'\\\s<>]+/gi
            ) || [];

          matches
            .slice(0, 40)
            .forEach((candidate) => {
              addValue(
                candidate,
                "page-script"
              );
            });
        }

        return {
          title: document.title,
          values,
          videoElementCount:
            videoElements.length,
          bodyText:
            document.body?.innerText
              ?.slice(0, 1_000) || "",
        };
      });

    pageEvidence.values.forEach(
      (value) => {
        addCandidateToMap(
          candidates,
          value
        );
      }
    );

    const firstVideo =
      page.locator("video").first();

    if (
      (await firstVideo.count()) > 0
    ) {
      try {
        await firstVideo.evaluate(
          async (video) => {
            video.muted = true;

            try {
              await video.play();
            } catch {
              // Autoplay may be blocked.
            }
          }
        );

        await page.waitForTimeout(4_000);

        const videoState =
          await firstVideo.evaluate(
            (video) => ({
              currentSrc:
                video.currentSrc,
              src: video.src,
            })
          );

        addCandidateToMap(
          candidates,
          {
            url:
              videoState.currentSrc,
            source:
              "video-after-play-currentSrc",
          }
        );

        addCandidateToMap(
          candidates,
          {
            url: videoState.src,
            source:
              "video-after-play-src",
          }
        );
      } catch {
        // Continue with the candidates already found.
      }
    }

    const cookies =
      await context.cookies();

    const cookieHeader = cookies
      .filter(
        (cookie) =>
          cookie.domain.includes(
            "instagram.com"
          ) ||
          cookie.domain.includes(
            "cdninstagram.com"
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
      pageTitle:
        pageEvidence.title || "",
      bodyTextPreview:
        pageEvidence.bodyText || "",
      videoElementCount:
        pageEvidence.videoElementCount,
      candidateList:
        Array.from(
          candidates.values()
        ),
      cookieHeader,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function combineInstagramTracks(
  {
    videoTrack,
    audioTrack,
    sourceUrl,
    cookieHeader = "",
    outputPath,
  },
  {
    timeoutMs =
      DEFAULT_PROCESS_TIMEOUT_MS,
  } = {}
) {
  requireFfmpegPath();

  if (!videoTrack?.url) {
    throw createResolverError(
      "No usable Instagram video track was found.",
      "PUBLIC_VIDEO_TRACK_NOT_FOUND"
    );
  }

  await mkdir(
    path.dirname(outputPath),
    {
      recursive: true,
    }
  );

  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/150.0.0.0 Safari/537.36";

  const requestHeaders = [
    `Referer: ${sourceUrl}`,
  ];

  if (cookieHeader) {
    requestHeaders.push(
      `Cookie: ${cookieHeader}`
    );
  }

  const headerValue =
    `${requestHeaders.join("\r\n")}\r\n`;

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",

    "-rw_timeout",
    "30000000",

    "-user_agent",
    userAgent,
    "-headers",
    headerValue,
    "-i",
    videoTrack.url,
  ];

  if (audioTrack?.url) {
    args.push(
      "-rw_timeout",
      "30000000",

      "-user_agent",
      userAgent,
      "-headers",
      headerValue,
      "-i",
      audioTrack.url,

      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c",
      "copy",
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath
    );
  } else {
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath
    );
  }

  await runProcess(
    requireFfmpegPath(),
    args,
    {
      timeoutMs,
    }
  );
}

export function isSupportedPublicVideoUrl(
  rawUrl
) {
  try {
    validateInstagramUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

export async function createPublicVideoResolverWorkspace() {
  return mkdtemp(
    path.join(
      os.tmpdir(),
      "simple-dinners-public-video-"
    )
  );
}

export async function cleanupPublicVideoResolverWorkspace(
  workspaceDir
) {
  if (!workspaceDir) return;

  await rm(workspaceDir, {
    recursive: true,
    force: true,
  });
}

export async function resolvePublicVideoToFile(
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
    validateInstagramUrl(rawUrl);

  if (!workspaceDir) {
    throw createResolverError(
      "A public video resolver workspace is required.",
      "PUBLIC_VIDEO_WORKSPACE_REQUIRED"
    );
  }

  let publicEmbedResult = null;

  try {
    publicEmbedResult =
      await tryResolveInstagramPublicEmbed(
        sourceUrl,
        {
          workspaceDir,
          processTimeoutMs,
          maxOutputBytes,
        }
      );
  } catch (error) {
    if (
      error?.skipBrowserFallback
    ) {
      throw error;
    }

    console.warn(
      "Instagram public embed resolver failed:",
      error instanceof Error
        ? error.message
        : String(error)
    );
  }

  if (publicEmbedResult) {
    console.log(
      "Instagram public embed resolver succeeded:",
      {
        sizeBytes:
          publicEmbedResult.sizeBytes,
        durationSeconds:
          publicEmbedResult.durationSeconds,
        captionLength:
          publicEmbedResult
            .publicEmbed
            ?.captionLength || 0,
        videoCodec:
          publicEmbedResult
            .publicEmbed
            ?.videoCodec || "",
        audioCodec:
          publicEmbedResult
            .publicEmbed
            ?.audioCodec || "",
      }
    );

    return publicEmbedResult;
  }

  const inspection =
    await inspectInstagramPage(
      sourceUrl,
      {
        headless,
        navigationTimeoutMs,
        discoveryWaitMs,
      }
    );

  const {
    videoTrack,
    audioTrack,
    mediaTracks,
  } = selectInstagramMediaTracks(
    inspection.candidateList
  );

  if (!videoTrack) {
    const error = createResolverError(
      "Simple Dinners could not access a public video for that Instagram link.",
      "PUBLIC_VIDEO_NOT_FOUND"
    );

    error.debug = {
      navigationStatus:
        inspection.navigationStatus,
      finalPageUrl:
        inspection.finalPageUrl,
      pageTitle:
        inspection.pageTitle,
      videoElementCount:
        inspection.videoElementCount,
      candidateCount:
        inspection.candidateList.length,
      bodyTextPreview:
        inspection.bodyTextPreview,
    };

    throw error;
  }

  const outputPath = path.join(
    workspaceDir,
    "resolved-instagram-video.mp4"
  );

  await combineInstagramTracks(
    {
      videoTrack,
      audioTrack,
      sourceUrl,
      cookieHeader:
        inspection.cookieHeader,
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
    throw createResolverError(
      "The resolved Instagram video was empty.",
      "PUBLIC_VIDEO_EMPTY"
    );
  }

  if (
    outputStats.size >
    maxOutputBytes
  ) {
    throw createResolverError(
      "The resolved Instagram video is larger than the supported limit.",
      "PUBLIC_VIDEO_TOO_LARGE"
    );
  }

  return {
    platform: "instagram",
    sourceUrl,
    outputPath,
    sizeBytes:
      outputStats.size,
    hasAudio:
      Boolean(audioTrack),
    durationSeconds:
      Math.max(
        Number(
          videoTrack.durationSeconds ||
          0
        ),
        Number(
          audioTrack?.durationSeconds ||
          0
        )
      ),
    candidateCount:
      inspection.candidateList.length,
    uniqueTrackCount:
      mediaTracks.length,
    videoTrack: {
      bitrate:
        videoTrack.bitrate,
      encodingTag:
        videoTrack.encodingTag,
    },
    audioTrack: audioTrack
      ? {
          bitrate:
            audioTrack.bitrate,
          encodingTag:
            audioTrack.encodingTag,
        }
      : null,
  };
}
