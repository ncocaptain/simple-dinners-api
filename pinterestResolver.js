import { chromium } from "playwright";

const PINTEREST_HOSTS = ["pinterest.com", "www.pinterest.com", "pin.it"];

const BAD_HOST_FRAGMENTS = [
  "pinterest.",
  "pinimg.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "chromewebstore.google.com",
  "chrome.google.com",
  "googleusercontent.com",
  "gstatic.com",
];

function isPinterestUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    return PINTEREST_HOSTS.includes(host) || host.endsWith(".pinterest.com");
  } catch {
    return false;
  }
}

function isPinItUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase() === "pin.it";
  } catch {
    return false;
  }
}

function isPinterestPinUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    return (
      (host === "pinterest.com" ||
        host === "www.pinterest.com" ||
        host.endsWith(".pinterest.com")) &&
      url.pathname.includes("/pin/")
    );
  } catch {
    return false;
  }
}

function decodePinterestText(value) {
  return value
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003D/g, "=")
    .replace(/\\u003F/g, "?")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function removeTrackingParams(rawUrl) {
  try {
    const url = new URL(rawUrl);

    const removableParams = [
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
      "igshid",
      "ref",
    ];

    for (const key of Array.from(url.searchParams.keys())) {
      const lowerKey = key.toLowerCase();

      if (lowerKey.startsWith("utm_") || removableParams.includes(lowerKey)) {
        url.searchParams.delete(key);
      }
    }

    return url.toString();
  } catch {
    return rawUrl;
  }
}

function cleanCandidateUrl(raw) {
  try {
    let cleaned = decodePinterestText(raw).trim();

    if (cleaned.startsWith("//")) {
      cleaned = `https:${cleaned}`;
    }

    if (!cleaned.startsWith("http://") && !cleaned.startsWith("https://")) {
      return null;
    }

    return removeTrackingParams(cleaned);
  } catch {
    return null;
  }
}

function isBadCandidate(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();

    if (BAD_HOST_FRAGMENTS.some((fragment) => host.includes(fragment))) {
      return true;
    }

    if (
      path.endsWith(".jpg") ||
      path.endsWith(".jpeg") ||
      path.endsWith(".png") ||
      path.endsWith(".webp") ||
      path.endsWith(".gif") ||
      path.endsWith(".svg")
    ) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

async function fetchPinterestHtml(inputUrl) {
  const response = await fetch(inputUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Pinterest returned ${response.status}`);
  }

  return {
    html: await response.text(),
    finalUrl: response.url || inputUrl,
  };
}

async function tryExpandPinItRedirect(inputUrl) {
  try {
    let currentUrl = inputUrl;

    for (let i = 0; i < 6; i += 1) {
      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const location = response.headers.get("location");

      if (!location) {
        return null;
      }

      const nextUrl = new URL(location, currentUrl).toString();

      if (isPinterestPinUrl(nextUrl)) {
        return nextUrl;
      }

      currentUrl = nextUrl;
    }

    return null;
  } catch {
    return null;
  }
}

async function tryExpandPinItWithPlaywright(inputUrl) {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
      viewport: { width: 412, height: 915 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const page = await context.newPage();

    await page.route("**/*", (route) => {
      const resourceType = route.request().resourceType();

      if (["image", "font", "media"].includes(resourceType)) {
        return route.abort();
      }

      return route.continue();
    });

    await page.goto(inputUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    await page.waitForTimeout(2500);

    const finalUrl = page.url();

    if (isPinterestPinUrl(finalUrl)) {
      return finalUrl;
    }

    const hrefs = await page.$$eval("a[href]", (links) =>
      links.map((link) => link.href)
    );

    const pinHref = hrefs.find((href) => {
      try {
        const parsed = new URL(href);
        const host = parsed.hostname.toLowerCase();

        return (
          (host === "pinterest.com" ||
            host === "www.pinterest.com" ||
            host.endsWith(".pinterest.com")) &&
          parsed.pathname.includes("/pin/")
        );
      } catch {
        return false;
      }
    });

    if (pinHref) {
      return pinHref;
    }

    const html = await page.content();
    return extractPinterestPinUrl(html, finalUrl);
  } catch {
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore browser close errors.
      }
    }
  }
}

async function tryPinterestOEmbed(pinUrl) {
  try {
    const endpoint = `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(
      pinUrl
    )}`;

    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) return null;

    const data = await response.json();

    return {
      title: typeof data.title === "string" ? data.title : undefined,
      html: typeof data.html === "string" ? data.html : undefined,
    };
  } catch {
    return null;
  }
}

function extractPinterestPinUrl(html, finalUrl) {
  if (isPinterestPinUrl(finalUrl)) {
    return finalUrl;
  }

  const decoded = decodePinterestText(html);

  const fullPinMatch = decoded.match(
    /https?:\/\/(?:www\.)?pinterest\.[a-z.]+\/pin\/[0-9]+\/?/i
  );

  if (fullPinMatch?.[0]) {
    return cleanCandidateUrl(fullPinMatch[0]);
  }

  const pinIdMatch =
    decoded.match(/"pin_id"\s*:\s*"([0-9]+)"/i) ||
    decoded.match(/\/pin\/([0-9]+)\/?/i);

  if (pinIdMatch?.[1]) {
    return `https://www.pinterest.com/pin/${pinIdMatch[1]}/`;
  }

  return null;
}

function extractExternalCandidates(html) {
  const decoded = decodePinterestText(html);

  const candidates = new Set();

  const patterns = [
    /"destination_url"\s*:\s*"([^"]+)"/g,
    /"dominant_link"\s*:\s*"([^"]+)"/g,
    /"website_url"\s*:\s*"([^"]+)"/g,
    /"domain_url"\s*:\s*"([^"]+)"/g,
    /"link"\s*:\s*"([^"]+)"/g,
    /"url"\s*:\s*"([^"]+)"/g,
    /"canonical_url"\s*:\s*"([^"]+)"/g,
    /property="og:url"\s+content="([^"]+)"/g,
    /name="twitter:url"\s+content="([^"]+)"/g,
    /href="([^"]+)"/g,
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(decoded)) !== null) {
      const candidate = cleanCandidateUrl(match[1]);

      if (candidate && !isBadCandidate(candidate)) {
        candidates.add(candidate);
      }
    }
  }

  return Array.from(candidates);
}

function chooseBestCandidate(candidates) {
  const cleaned = candidates.filter((candidate) => !isBadCandidate(candidate));

  if (cleaned.length === 0) return null;

  const likelyRecipe = cleaned.find((candidate) => {
    const lower = candidate.toLowerCase();

    return (
      lower.includes("recipe") ||
      lower.includes("food") ||
      lower.includes("kitchen") ||
      lower.includes("cooking") ||
      lower.includes("dinner") ||
      lower.includes("baking")
    );
  });

  return likelyRecipe || cleaned[0];
}

export async function resolvePinterestRecipeUrl(inputUrl) {
  if (!isPinterestUrl(inputUrl)) {
    return {
      ok: false,
      source: "pinterest",
      inputUrl,
      error: "This does not look like a Pinterest URL.",
    };
  }

  try {
    let { html, finalUrl } = await fetchPinterestHtml(inputUrl);
    let finalPinterestUrl = finalUrl;

    if (isPinItUrl(inputUrl) || isPinItUrl(finalUrl)) {
  const inputOembed = await tryPinterestOEmbed(inputUrl);
  const oembedPinUrl = inputOembed?.html
    ? extractPinterestPinUrl(inputOembed.html, inputUrl)
    : null;

  const redirectPinUrl = await tryExpandPinItRedirect(inputUrl);
  const htmlPinUrl = extractPinterestPinUrl(html, finalUrl);

  const playwrightPinUrl =
    redirectPinUrl || htmlPinUrl || oembedPinUrl
      ? null
      : await tryExpandPinItWithPlaywright(inputUrl);

  const expandedPinUrl =
    redirectPinUrl || htmlPinUrl || oembedPinUrl || playwrightPinUrl;

  if (!expandedPinUrl) {
    return {
      ok: false,
      source: "pinterest",
      inputUrl,
      finalPinterestUrl: finalUrl,
      error: "Could not expand this Pinterest short link.",
    };
  }

  const expanded = await fetchPinterestHtml(expandedPinUrl);

  html = expanded.html;
  finalPinterestUrl = expanded.finalUrl || expandedPinUrl;
}

    const oembed = await tryPinterestOEmbed(finalPinterestUrl);

    const candidates = extractExternalCandidates(html);
    const resolvedUrl = chooseBestCandidate(candidates);

    if (!resolvedUrl) {
      return {
        ok: false,
        source: "pinterest",
        inputUrl,
        finalPinterestUrl,
        error: "Could not find an external recipe link from this Pinterest pin.",
      };
    }

    return {
      ok: true,
      source: "pinterest",
      inputUrl,
      finalPinterestUrl,
      resolvedUrl,
      strategy: "html-destination",
      title: oembed?.title,
    };
  } catch (error) {
    return {
      ok: false,
      source: "pinterest",
      inputUrl,
      error:
        error instanceof Error
          ? error.message
          : "Pinterest resolver failed.",
    };
  }
}

export function isPinterestRecipeCandidate(inputUrl) {
  return isPinterestUrl(inputUrl);
}