const PINTEREST_HOSTS = ["pinterest.com", "www.pinterest.com", "pin.it"];

function isPinterestUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    return PINTEREST_HOSTS.includes(host) || host.endsWith(".pinterest.com");
  } catch {
    return false;
  }
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
    let cleaned = raw
  .replace(/\\u002F/g, "/")
  .replace(/\\u0026/g, "&")
  .replace(/\\\//g, "/")
  .replace(/&amp;/g, "&")
  .trim();

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

    if (host.includes("pinterest.")) return true;
    if (host.includes("pinimg.com")) return true;
    if (host.includes("facebook.com")) return true;
    if (host.includes("instagram.com")) return true;
    if (host.includes("tiktok.com")) return true;
    if (host.includes("youtube.com")) return true;
    if (host.includes("youtu.be")) return true;

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
    };
  } catch {
    return null;
  }
}

function extractExternalCandidates(html) {
  const decoded = html
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");

  const candidates = new Set();

  const patterns = [
    /"link"\s*:\s*"([^"]+)"/g,
    /"url"\s*:\s*"([^"]+)"/g,
    /"website_url"\s*:\s*"([^"]+)"/g,
    /"domain_url"\s*:\s*"([^"]+)"/g,
    /"canonical_url"\s*:\s*"([^"]+)"/g,
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
    const { html, finalUrl } = await fetchPinterestHtml(inputUrl);
    const oembed = await tryPinterestOEmbed(finalUrl);

    const candidates = extractExternalCandidates(html);
    const resolvedUrl = chooseBestCandidate(candidates);

    if (!resolvedUrl) {
      return {
        ok: false,
        source: "pinterest",
        inputUrl,
        finalPinterestUrl: finalUrl,
        error: "Could not find an external recipe link from this Pinterest pin.",
      };
    }

    return {
      ok: true,
      source: "pinterest",
      inputUrl,
      finalPinterestUrl: finalUrl,
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