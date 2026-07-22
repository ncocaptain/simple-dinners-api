import { chromium } from "playwright";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

const DEFAULT_TEST_URL =
  "https://www.instagram.com/reel/DZnKxEHk5RL/";

const targetUrl =
  process.argv[2]?.trim() ||
  DEFAULT_TEST_URL;

const headless =
  process.env.HEADLESS !== "false";

const ALLOWED_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
]);

function validateTargetUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      "Please provide a valid Instagram URL."
    );
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      "Only HTTPS Instagram URLs are supported."
    );
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      "This proof of concept currently supports Instagram only."
    );
  }

  return parsed.toString();
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

function looksLikeVideoUrl(
  candidateUrl,
  contentType = ""
) {
  const url = String(candidateUrl || "");
  const type = String(contentType || "")
    .toLowerCase();

  return (
    type.startsWith("video/") ||
    type.includes("mpegurl") ||
    /\.(mp4|m4v|mov|webm|m3u8)(?:[?#]|$)/i.test(url) ||
    /\/video\/|video_dashinit|videoplayback/i.test(url)
  );
}

function candidatePriority(candidate) {
  const url = candidate.url.toLowerCase();
  const type = candidate.contentType.toLowerCase();

  if (
    type.includes("video/mp4") ||
    /\.mp4(?:[?#]|$)/i.test(url)
  ) {
    return 1;
  }

  if (
    type.includes("mpegurl") ||
    /\.m3u8(?:[?#]|$)/i.test(url)
  ) {
    return 2;
  }

  if (type.startsWith("video/")) {
    return 3;
  }

  return 4;
}

function removeByteRangeParameters(rawUrl) {
  const parsed = new URL(rawUrl);

  parsed.searchParams.delete("bytestart");
  parsed.searchParams.delete("byteend");

  return parsed.toString();
}

function readInstagramEncodingMetadata(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const encoded = parsed.searchParams.get("efg");

    if (!encoded) {
      return null;
    }

    const decoded = Buffer.from(
      encoded,
      "base64"
    ).toString("utf8");

    return JSON.parse(decoded);
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

async function createCombinedVideo({
  videoTrack,
  audioTrack,
  sourceUrl,
}) {
  if (!ffmpegPath) {
    throw new Error(
      "The bundled FFmpeg binary could not be found."
    );
  }

  if (!videoTrack?.url) {
    throw new Error(
      "No usable Instagram video track was found."
    );
  }

  const outputDirectory =
    path.resolve(
      "tmp-public-video-test"
    );

  const outputPath = path.join(
    outputDirectory,
    "instagram-reel.mp4"
  );

  await rm(outputDirectory, {
    recursive: true,
    force: true,
  });

  await mkdir(outputDirectory, {
    recursive: true,
  });

  const browserUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/150.0.0.0 Safari/537.36";

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",

    "-user_agent",
    browserUserAgent,
    "-headers",
    `Referer: ${sourceUrl}\r\n`,
    "-i",
    videoTrack.url,
  ];

  if (audioTrack?.url) {
    args.push(
      "-user_agent",
      browserUserAgent,
      "-headers",
      `Referer: ${sourceUrl}\r\n`,
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

  const result = spawnSync(
    ffmpegPath,
    args,
    {
      encoding: "utf8",
      maxBuffer:
        10 * 1024 * 1024,
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      result.stderr ||
      `FFmpeg exited with code ${result.status}.`
    );
  }

  const outputStats =
    await stat(outputPath);

  if (
    !outputStats.isFile() ||
    outputStats.size === 0
  ) {
    throw new Error(
      "FFmpeg did not create a usable combined video."
    );
  }

  return {
    outputPath,
    sizeBytes: outputStats.size,
  };
}

const validatedUrl =
  validateTargetUrl(targetUrl);

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

function addCandidate({
  url,
  source,
  contentType = "",
  status = null,
}) {
  const cleanedUrl =
    cleanCandidateUrl(url);

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
    )
  ) {
    return;
  }

  const existing =
    candidates.get(cleanedUrl);

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

page.on("response", (response) => {
  try {
    const responseUrl =
      response.url();

    const headers =
      response.headers();

    const contentType =
      headers["content-type"] || "";

    if (
      looksLikeVideoUrl(
        responseUrl,
        contentType
      )
    ) {
      addCandidate({
        url: responseUrl,
        source: "network-response",
        contentType,
        status: response.status(),
      });
    }
  } catch {
    // Ignore individual response inspection errors.
  }
});

page.on("request", (request) => {
  try {
    const requestUrl =
      request.url();

    if (
      looksLikeVideoUrl(requestUrl)
    ) {
      addCandidate({
        url: requestUrl,
        source: "network-request",
      });
    }
  } catch {
    // Ignore individual request inspection errors.
  }
});

try {
  console.log(
    "Opening public Instagram reel..."
  );

  console.log(validatedUrl);

  const navigationResponse =
    await page.goto(validatedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

  console.log(
    "Page response status:",
    navigationResponse?.status() ??
    "unknown"
  );

  await page.waitForTimeout(5_000);

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
          document.querySelector(selector);

        addValue(
          element?.getAttribute("content"),
          source
        );
      }

      const videoElements =
        Array.from(
          document.querySelectorAll("video")
        );

      for (
        let index = 0;
        index < videoElements.length;
        index += 1
      ) {
        const video =
          videoElements[index];

        addValue(
          video.currentSrc,
          `video-${index + 1}-currentSrc`
        );

        addValue(
          video.src,
          `video-${index + 1}-src`
        );

        const sources =
          Array.from(
            video.querySelectorAll("source")
          );

        sources.forEach(
          (sourceElement, sourceIndex) => {
            addValue(
              sourceElement.src,
              `video-${index + 1}-source-${sourceIndex + 1}`,
              sourceElement.type
            );
          }
        );
      }

      const scriptCandidates = [];

      for (
        const script of Array.from(
          document.scripts
        )
      ) {
        const content =
          script.textContent || "";

        if (
          content.length === 0 ||
          content.length > 3_000_000
        ) {
          continue;
        }

        if (
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

        scriptCandidates.push(
          ...matches.slice(0, 40)
        );
      }

      for (
        const candidate of scriptCandidates
      ) {
        addValue(
          candidate,
          "page-script"
        );
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

  console.log(
    "Page title:",
    pageEvidence.title || "(none)"
  );

  console.log(
    "Video elements found:",
    pageEvidence.videoElementCount
  );

  for (
    const value of pageEvidence.values
  ) {
    addCandidate(value);
  }

  const firstVideo =
    page.locator("video").first();

  if (
    (await firstVideo.count()) > 0
  ) {
    console.log(
      "Attempting to start the reel..."
    );

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
    } catch {
      // Continue with existing page evidence.
    }

    await page.waitForTimeout(6_000);

    try {
      const videoState =
        await firstVideo.evaluate(
          (video) => ({
            currentSrc:
              video.currentSrc,
            src: video.src,
            duration:
              Number.isFinite(
                video.duration
              )
                ? video.duration
                : null,
            readyState:
              video.readyState,
          })
        );

      addCandidate({
        url: videoState.currentSrc,
        source:
          "video-after-play-currentSrc",
      });

      addCandidate({
        url: videoState.src,
        source:
          "video-after-play-src",
      });

      console.log(
        "Video element state:",
        videoState
      );
    } catch {
      // Continue to candidate output.
    }
  }

  const candidateList =
    Array.from(candidates.values())
      .sort(
        (a, b) =>
          candidatePriority(a) -
          candidatePriority(b)
      );

  console.log("\nResolver result:");

  if (candidateList.length === 0) {
    console.log(
      "No accessible video candidate was discovered."
    );

    console.log(
      "\nPage text preview:"
    );

    console.log(
      pageEvidence.bodyText ||
      "(No readable page text.)"
    );
  } else {
    console.log(
      JSON.stringify(
        candidateList,
        null,
        2
      )
    );
  }

  console.log(
    `\nFound ${candidateList.length} candidate(s).`
  );
  if (candidateList.length > 0) {
    const {
      videoTrack,
      audioTrack,
      mediaTracks,
    } = selectInstagramMediaTracks(
      candidateList
    );

    console.log(
      "\nUnique Instagram media tracks:"
    );

    console.log(
      mediaTracks.map((track) => ({
        kind: track.kind,
        bitrate: track.bitrate,
        durationSeconds:
          track.durationSeconds,
        encodingTag:
          track.encodingTag,
      }))
    );

    console.log(
      "\nSelected video track:"
    );

    console.log({
      bitrate:
        videoTrack?.bitrate || 0,
      durationSeconds:
        videoTrack?.durationSeconds || 0,
      encodingTag:
        videoTrack?.encodingTag || "",
    });

    console.log(
      "\nSelected audio track:"
    );

    console.log({
      found: Boolean(audioTrack),
      bitrate:
        audioTrack?.bitrate || 0,
      durationSeconds:
        audioTrack?.durationSeconds || 0,
      encodingTag:
        audioTrack?.encodingTag || "",
    });

    console.log(
      "\nCombining Instagram media..."
    );

    const combinedVideo =
      await createCombinedVideo({
        videoTrack,
        audioTrack,
        sourceUrl: validatedUrl,
      });

    console.log(
      "\nCombined video created:"
    );

    console.log(
      `- ${combinedVideo.outputPath}`
    );

    console.log(
      `- ${Math.round(
        combinedVideo.sizeBytes / 1024
      )} KB`
    );
  }
} finally {
  await context.close();
  await browser.close();
}