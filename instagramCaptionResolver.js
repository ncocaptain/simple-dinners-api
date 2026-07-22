import { chromium } from "playwright";

const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
]);

function createCaptionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateInstagramUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw createCaptionError(
      "Please provide a valid Instagram URL.",
      "INVALID_INSTAGRAM_URL"
    );
  }

  if (parsed.protocol !== "https:") {
    throw createCaptionError(
      "Only HTTPS Instagram URLs are supported.",
      "INVALID_INSTAGRAM_URL"
    );
  }

  const host = parsed.hostname.toLowerCase();

  if (!INSTAGRAM_HOSTS.has(host)) {
    throw createCaptionError(
      "This caption resolver currently supports Instagram only.",
      "UNSUPPORTED_CAPTION_PLATFORM"
    );
  }

  if (!/^\/(reel|reels|p)\//i.test(parsed.pathname)) {
    throw createCaptionError(
      "Please provide an Instagram reel or post URL.",
      "UNSUPPORTED_INSTAGRAM_PATH"
    );
  }

  parsed.hash = "";

  return parsed.toString();
}

function normalizeCaptionText(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u2026/gi, "…")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanInstagramDescriptionWrapper(value) {
  let text = normalizeCaptionText(value);

  text = text
    .replace(
      /^[\d.,KMBkmb+\s]+likes?,\s*[\d.,KMBkmb+\s]+comments?\s*-\s*/i,
      ""
    )
    .replace(/^Instagram\s*:\s*/i, "")
    .replace(
      /^[^:\n]{1,120}\s+on\s+Instagram\s*:\s*/i,
      ""
    )
    .replace(
      /^[^:\n]{1,120}\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s*:\s*/i,
      ""
    )
    .trim();

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("“") && text.endsWith("”"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

function looksGenericInstagramText(value) {
  const text = String(value || "").toLowerCase();

  return (
    !text ||
    text === "instagram" ||
    text.includes("see instagram photos and videos") ||
    text.includes("create an account or log in") ||
    text.includes("log in to see photos and videos") ||
    text.includes("from the people you care about") ||
    text.includes("welcome back to instagram")
  );
}

function recipeSignalScore(value) {
  const text = String(value || "");
  let score = 0;

  if (
    /\bingredients?\b|\bwhat you(?:'|’)?ll need\b/i.test(text)
  ) {
    score += 25;
  }

  if (
    /\binstructions?\b|\bdirections?\b|\bmethod\b|\bsteps?\b/i.test(text)
  ) {
    score += 25;
  }

  if (
    /\b(cup|cups|tablespoons?|tbsp|teaspoons?|tsp|ounces?|oz|pounds?|lbs?|grams?|ml|°f|°c)\b/i.test(
      text
    )
  ) {
    score += 20;
  }

  if (
    /\b(bake|cook|stir|mix|whisk|roast|boil|simmer|fry|grill|season|serve|preheat)\b/i.test(
      text
    )
  ) {
    score += 15;
  }

  if (text.includes("\n")) {
    score += 5;
  }

  return score;
}

function scoreCaptionCandidate(candidate) {
  const text = cleanInstagramDescriptionWrapper(
    candidate.text
  );

  if (
    text.length < 3 ||
    looksGenericInstagramText(text)
  ) {
    return -1000;
  }

  const sourceBaseScore = {
    "script-caption": 120,
    "script-caption-text": 115,
    "script-edge-caption": 110,
    "og-description": 90,
    "meta-description": 80,
    "twitter-description": 75,
    "article-text": 45,
    "main-text": 35,
  }[candidate.source] || 10;

  const usefulLengthScore =
    Math.min(text.length, 1200) / 40;

  const excessiveLengthPenalty =
    text.length > 6000
      ? 100
      : text.length > 3000
        ? 30
        : 0;

  return (
    sourceBaseScore +
    usefulLengthScore +
    recipeSignalScore(text) -
    excessiveLengthPenalty
  );
}

function dedupeCaptionCandidates(candidates) {
  const seen = new Set();
  const output = [];

  for (const candidate of candidates) {
    const text =
      cleanInstagramDescriptionWrapper(
        candidate.text
      );

    const key = text
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);

    output.push({
      ...candidate,
      text,
      score: scoreCaptionCandidate({
        ...candidate,
        text,
      }),
    });
  }

  return output.sort(
    (a, b) => b.score - a.score
  );
}

function chooseBestCaptionCandidate(candidates) {
  const canonicalSourceOrder = [
    "og-description",
    "meta-description",
    "twitter-description",
  ];

  for (const source of canonicalSourceOrder) {
    const candidate = candidates.find(
      (item) =>
        item.source === source &&
        item.score > 0 &&
        !looksGenericInstagramText(
          item.text
        )
    );

    if (candidate) {
      return candidate;
    }
  }

  return (
    candidates.find(
      (candidate) =>
        candidate.score > 0
    ) || null
  );
}

export async function resolveInstagramCaption(
  rawUrl,
  {
    headless = true,
    navigationTimeoutMs = 45_000,
    waitAfterLoadMs = 5_000,
  } = {}
) {
  const sourceUrl =
    validateInstagramUrl(rawUrl);

  const browser = await chromium.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const context = await browser.newContext({
    viewport: {
      width: 1280,
      height: 900,
    },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/150.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    const navigationResponse =
      await page.goto(sourceUrl, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs,
      });

    await page.waitForTimeout(waitAfterLoadMs);

    const pageEvidence =
      await page.evaluate(() => {
        const candidates = [];

        const addCandidate = (
          text,
          source
        ) => {
          if (!text) return;

          candidates.push({
            text,
            source,
          });
        };

        addCandidate(
          document
            .querySelector(
              'meta[property="og:description"]'
            )
            ?.getAttribute("content"),
          "og-description"
        );

        addCandidate(
          document
            .querySelector(
              'meta[name="description"]'
            )
            ?.getAttribute("content"),
          "meta-description"
        );

        addCandidate(
          document
            .querySelector(
              'meta[name="twitter:description"]'
            )
            ?.getAttribute("content"),
          "twitter-description"
        );

        const article =
          document.querySelector("article");

        if (article?.innerText) {
          addCandidate(
            article.innerText.slice(0, 12_000),
            "article-text"
          );
        }

        const main =
          document.querySelector("main");

        if (main?.innerText) {
          addCandidate(
            main.innerText.slice(0, 12_000),
            "main-text"
          );
        }

        const scriptPatterns = [
          {
            source: "script-caption",
            pattern:
              /"caption"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
          },
          {
            source: "script-caption-text",
            pattern:
              /"caption_text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
          },
          {
            source: "script-edge-caption",
            pattern:
              /"edge_media_to_caption"\s*:\s*\{[\s\S]{0,1600}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
          },
        ];

        const decodeCapturedJsonString = (
          captured
        ) => {
          try {
            return JSON.parse(
              `"${captured}"`
            );
          } catch {
            return captured;
          }
        };

        for (
          const script of Array.from(
            document.scripts
          )
        ) {
          const content =
            script.textContent || "";

          if (
            content.length === 0 ||
            content.length > 5_000_000 ||
            !/caption|edge_media_to_caption/i.test(
              content
            )
          ) {
            continue;
          }

          for (
            const {
              source,
              pattern,
            } of scriptPatterns
          ) {
            pattern.lastIndex = 0;

            let match;
            let matchCount = 0;

            while (
              (match =
                pattern.exec(content)) &&
              matchCount < 15
            ) {
              addCandidate(
                decodeCapturedJsonString(
                  match[1]
                ),
                source
              );

              matchCount += 1;
            }
          }
        }

        return {
          title:
            document
              .querySelector(
                'meta[property="og:title"]'
              )
              ?.getAttribute("content") ||
            document.title ||
            "",

          imageUrl:
            document
              .querySelector(
                'meta[property="og:image"]'
              )
              ?.getAttribute("content") ||
            "",

          bodyTextPreview:
            document.body?.innerText
              ?.slice(0, 1200) || "",

          candidates,
        };
      });

    const candidates =
      dedupeCaptionCandidates(
        pageEvidence.candidates
      );

    const bestCandidate =
      chooseBestCaptionCandidate(
        candidates
      );

    return {
      success: Boolean(bestCandidate),
      platform: "instagram",
      sourceUrl,
      navigationStatus:
        navigationResponse?.status() ??
        null,

      captionText:
        bestCandidate?.text || "",

      captionSource:
        bestCandidate?.source || "",

      captionScore:
        bestCandidate?.score || 0,

      title:
        normalizeCaptionText(
          pageEvidence.title
        ),

      imageUrl:
        normalizeCaptionText(
          pageEvidence.imageUrl
        ),

      candidateCount:
        candidates.length,

      candidates:
        candidates.slice(0, 8),

      bodyTextPreview:
        pageEvidence.bodyTextPreview,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
