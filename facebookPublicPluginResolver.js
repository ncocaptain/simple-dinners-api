const FACEBOOK_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

const FACEBOOK_CRAWLER_USER_AGENT =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

function isFacebookHost(
  hostname
) {
  const host =
    String(hostname || "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");

  return (
    host === "facebook.com" ||
    host.endsWith(".facebook.com") ||
    host === "fb.watch" ||
    host.endsWith(".fb.watch") ||
    host === "fb.com" ||
    host.endsWith(".fb.com")
  );
}

function isFacebookShortLink(
  value
) {
  return (
    /fb\.watch\//i.test(
      value
    ) ||
    /facebook\.com\/share\//i.test(
      value
    ) ||
    /fb\.com\//i.test(
      value
    )
  );
}

function isFacebookMediaUrl(
  value
) {
  try {
    const parsed =
      new URL(value);

    const host =
      parsed.hostname
        .toLowerCase();

    return (
      parsed.protocol === "https:" &&
      (
        host === "fbcdn.net" ||
        host.endsWith(
          ".fbcdn.net"
        )
      )
    );
  } catch {
    return false;
  }
}

function unwrapLoginWall(
  value
) {
  try {
    const parsed =
      new URL(value);

    if (
      /\/login/i.test(
        parsed.pathname
      )
    ) {
      const next =
        parsed.searchParams.get(
          "next"
        );

      if (next) {
        return decodeURIComponent(
          next
        );
      }
    }
  } catch {
    // Preserve the original URL.
  }

  return value;
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
      () => {
        controller.abort();
      },
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
  } finally {
    clearTimeout(timeout);
  }
}

function decodeFacebookString(
  value
) {
  if (!value) {
    return "";
  }

  try {
    return JSON.parse(
      `"${value}"`
    );
  } catch {
    return String(value)
      .replace(
        /\\u0025/gi,
        "%"
      )
      .replace(
        /\\u002F/gi,
        "/"
      )
      .replace(
        /\\\//g,
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
        /\\u003F/gi,
        "?"
      )
      .replace(
        /\\u([\dA-Fa-f]{4})/g,
        (_, hex) =>
          String.fromCharCode(
            parseInt(
              hex,
              16
            )
          )
      )
      .replace(
        /\\/g,
        ""
      );
  }
}

function extractCandidates(
  html
) {
  const fields = [
    {
      key:
        "browser_native_hd_url",
      quality:
        "hd",
    },
    {
      key:
        "playable_url_quality_hd",
      quality:
        "hd",
    },
    {
      key:
        "hd_src_no_ratelimit",
      quality:
        "hd",
    },
    {
      key:
        "hd_src",
      quality:
        "hd",
    },
    {
      key:
        "browser_native_sd_url",
      quality:
        "sd",
    },
    {
      key:
        "playable_url",
      quality:
        "sd",
    },
    {
      key:
        "sd_src_no_ratelimit",
      quality:
        "sd",
    },
    {
      key:
        "sd_src",
      quality:
        "sd",
    },
  ];

  const candidates = [];
  const seen = new Set();

  for (
    const field of fields
  ) {
    const pattern =
      new RegExp(
        `"${field.key}":"((?:\\\\.|[^"])*)"`,
        "i"
      );

    const match =
      String(html || "")
        .match(pattern);

    if (!match?.[1]) {
      continue;
    }

    const mediaUrl =
      decodeFacebookString(
        match[1]
      );

    if (
      !mediaUrl ||
      seen.has(mediaUrl) ||
      !isFacebookMediaUrl(
        mediaUrl
      )
    ) {
      continue;
    }

    seen.add(mediaUrl);

    candidates.push({
      key:
        field.key,
      quality:
        field.quality,
      url:
        mediaUrl,
    });
  }

  return candidates;
}

export async function resolveFacebookPublicUrl(
  sourceUrl
) {
  if (
    !isFacebookShortLink(
      sourceUrl
    )
  ) {
    return sourceUrl;
  }

  try {
    const response =
      await fetchWithTimeout(
        sourceUrl,
        {
          method: "HEAD",
          redirect:
            "follow",
          headers: {
            "User-Agent":
              FACEBOOK_CRAWLER_USER_AGENT,
          },
        },
        12_000
      );

    try {
      await response.body?.cancel();
    } catch {
      // Redirect target is already known.
    }

    const resolvedUrl =
      unwrapLoginWall(
        response.url ||
        sourceUrl
      );

    const parsed =
      new URL(
        resolvedUrl
      );

    if (
      isFacebookHost(
        parsed.hostname
      )
    ) {
      return resolvedUrl;
    }
  } catch {
    // Fall back to the original URL.
  }

  return sourceUrl;
}

export async function resolveFacebookPublicPlugin(
  sourceUrl
) {
  const canonicalUrl =
    await resolveFacebookPublicUrl(
      sourceUrl
    );

  const pluginUrl =
    `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(
      canonicalUrl
    )}`;

  const response =
    await fetchWithTimeout(
      pluginUrl,
      {
        headers: {
          "User-Agent":
            FACEBOOK_BROWSER_USER_AGENT,
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

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // No-op.
    }

    return null;
  }

  const html =
    await response.text();

  const candidates =
    extractCandidates(
      html
    );

  if (
    candidates.length === 0
  ) {
    return null;
  }

  const selected =
    candidates[0];

  return {
    canonicalUrl,
    pluginUrl,

    selectedMediaUrl:
      selected.url,

    selectedQuality:
      selected.quality,

    selectedKey:
      selected.key,

    candidateCount:
      candidates.length,

    candidates,

    userAgent:
      FACEBOOK_BROWSER_USER_AGENT,
  };
}
