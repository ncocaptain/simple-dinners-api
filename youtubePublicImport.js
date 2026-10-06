const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

const YOUTUBE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Safari/537.36";

function createYouTubeError(
  message,
  code,
  statusCode = 500
) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validateYouTubeUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(
      String(rawUrl || "").trim()
    );
  } catch {
    throw createYouTubeError(
      "Please provide a valid YouTube URL.",
      "INVALID_YOUTUBE_URL",
      400
    );
  }

  if (parsed.protocol !== "https:") {
    throw createYouTubeError(
      "Only HTTPS YouTube URLs are supported.",
      "INVALID_YOUTUBE_URL",
      400
    );
  }

  const host =
    parsed.hostname
      .toLowerCase()
      .replace(/\.$/, "");

  if (!YOUTUBE_HOSTS.has(host)) {
    throw createYouTubeError(
      "This importer currently supports YouTube only.",
      "UNSUPPORTED_YOUTUBE_HOST",
      400
    );
  }

  return parsed.toString();
}

function extractYouTubeVideoId(
  rawUrl
) {
  try {
    const parsed =
      new URL(rawUrl);

    const host =
      parsed.hostname
        .toLowerCase()
        .replace(/\.$/, "");

    if (host === "youtu.be") {
      return (
        parsed.pathname
          .split("/")
          .filter(Boolean)[0] ||
        ""
      );
    }

    if (
      parsed.pathname ===
      "/watch"
    ) {
      return (
        parsed.searchParams.get(
          "v"
        ) || ""
      );
    }

    const pathMatch =
      parsed.pathname.match(
        /^\/(?:shorts|embed|live)\/([^/?#]+)/
      );

    return (
      pathMatch?.[1] || ""
    );
  } catch {
    return "";
  }
}

function buildCanonicalYouTubeUrl(
  videoId
) {
  return videoId
    ? `https://www.youtube.com/watch?v=${videoId}`
    : "";
}

function extractBalancedJson(
  text,
  marker
) {
  const markerIndex =
    text.indexOf(marker);

  if (markerIndex < 0) {
    return null;
  }

  const start =
    text.indexOf(
      "{",
      markerIndex +
        marker.length
    );

  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (
    let index = start;
    index < text.length;
    index++
  ) {
    const char =
      text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (
        char === "\\"
      ) {
        escaped = true;
      } else if (
        char === '"'
      ) {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth++;
    } else if (
      char === "}"
    ) {
      depth--;

      if (depth === 0) {
        return text.slice(
          start,
          index + 1
        );
      }
    }
  }

  return null;
}

function extractPlayerResponse(
  html
) {
  const markers = [
    "ytInitialPlayerResponse =",
    "var ytInitialPlayerResponse =",
    'window["ytInitialPlayerResponse"] =',
  ];

  for (const marker of markers) {
    const raw =
      extractBalancedJson(
        html,
        marker
      );

    if (!raw) continue;

    try {
      return JSON.parse(raw);
    } catch {
      // Try the next form.
    }
  }

  return null;
}

function normalizeParsedRecipe(
  parsedRecipe,
  cleanText
) {
  const ingredients =
    Array.isArray(
      parsedRecipe?.ingredients
    )
      ? parsedRecipe.ingredients
          .map((item) =>
            cleanText(item)
          )
          .filter(Boolean)
      : [];

  const instructions =
    Array.isArray(
      parsedRecipe?.instructions
    )
      ? parsedRecipe.instructions
          .map((item) =>
            cleanText(item)
          )
          .filter(Boolean)
      : [];

  return {
    name:
      cleanText(
        parsedRecipe?.name ||
        ""
      ),

    ingredients,
    instructions,

    effort:
      parsedRecipe?.effort,

    tags:
      parsedRecipe?.tags,

    isVegetarian:
      parsedRecipe
        ?.isVegetarian,

    notes:
      parsedRecipe?.notes,
  };
}

function parsedRecipeHasCoreContent(
  recipe
) {
  return (
    recipe.ingredients.length >
      0 &&
    recipe.instructions.length >
      0
  );
}

function parsedRecipeHasUsefulContent(
  recipe
) {
  if (
    !parsedRecipeHasCoreContent(
      recipe
    )
  ) {
    return false;
  }

  const ingredientCount =
    recipe.ingredients.length;

  const instructionCount =
    recipe.instructions.length;

  // Avoid treating a single ingredient plus a single
  // vague sentence as a complete recipe.
  //
  // Still allow genuinely simple recipes when either
  // the ingredient list or the instruction set has
  // enough substance to be useful.
  return (
    ingredientCount >= 2 ||
    instructionCount >= 2
  );
}

function ingredientHasExplicitAmount(
  value
) {
  const text =
    String(value || "")
      .trim();

  if (
    !text ||
    text.endsWith(":")
  ) {
    return false;
  }

  return /^(?:about\s+|approx(?:imately)?\.?\s+|around\s+|roughly\s+)?(?:(?:\d+(?:\.\d+)?\s*(?:-|–|to)\s*\d+(?:\.\d+)?)|(?:\d+\s+\d+\/\d+)|(?:\d+\/\d+)|(?:\d+(?:\.\d+)?)|[¼½¾⅓⅔⅛⅜⅝⅞]|(?:one|two|three|four|five|six|seven|eight|nine|ten))(?=\s|\(|$)/i.test(
    text
  );
}

function getMeasurementCoverage(
  ingredients
) {
  const lines =
    Array.isArray(ingredients)
      ? ingredients.filter(
          (ingredient) => {
            const text =
              String(
                ingredient || ""
              ).trim();

            return (
              text &&
              !text.endsWith(":")
            );
          }
        )
      : [];

  if (!lines.length) {
    return 0;
  }

  return (
    lines.filter(
      ingredientHasExplicitAmount
    ).length /
    lines.length
  );
}

function descriptionLooksLikeRecipeTeaser(
  value
) {
  const text =
    String(value || "");

  return (
    /\bfull recipe\b[\s\S]{0,120}\b(?:link|website|bio|description)\b/i.test(
      text
    ) ||
    /\brecipe\s+link\b/i.test(
      text
    ) ||
    /\bfull step[-\s]?by[-\s]?step\b/i.test(
      text
    )
  );
}

function decodeCaptionText(
  value
) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJson3Transcript(
  payload
) {
  if (
    !payload ||
    !Array.isArray(
      payload.events
    )
  ) {
    return "";
  }

  return payload.events
    .flatMap(
      (event) =>
        Array.isArray(
          event?.segs
        )
          ? event.segs
          : []
    )
    .map((segment) =>
      decodeCaptionText(
        segment?.utf8
      )
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchCaptionTranscript(
  captionTracks
) {
  if (
    !Array.isArray(
      captionTracks
    ) ||
    captionTracks.length === 0
  ) {
    return {
      text: "",
      languageCode: "",
      trackCount: 0,
    };
  }

  const preferred =
    captionTracks.find(
      (track) =>
        track?.languageCode ===
        "en"
    ) ||
    captionTracks.find(
      (track) =>
        String(
          track?.languageCode ||
          ""
        ).startsWith("en")
    ) ||
    captionTracks[0];

  const baseUrl =
    String(
      preferred?.baseUrl || ""
    ).trim();

  if (!baseUrl) {
    return {
      text: "",
      languageCode:
        preferred
          ?.languageCode ||
        "",
      trackCount:
        captionTracks.length,
    };
  }

  try {
    const transcriptUrl =
      new URL(baseUrl);

    transcriptUrl
      .searchParams
      .set(
        "fmt",
        "json3"
      );

    const response =
      await fetch(
        transcriptUrl,
        {
          headers: {
            "User-Agent":
              YOUTUBE_USER_AGENT,
            "Accept-Language":
              "en-US,en;q=0.9",
          },

          signal:
            AbortSignal.timeout(
              12_000
            ),
        }
      );

    if (!response.ok) {
      return {
        text: "",
        languageCode:
          preferred
            ?.languageCode ||
          "",
        trackCount:
          captionTracks.length,
      };
    }

    const raw =
      await response.text();

    let payload;

    try {
      payload =
        JSON.parse(raw);
    } catch {
      return {
        text: "",
        languageCode:
          preferred
            ?.languageCode ||
          "",
        trackCount:
          captionTracks.length,
      };
    }

    return {
      text:
        extractJson3Transcript(
          payload
        ),

      languageCode:
        preferred
          ?.languageCode ||
        "",

      trackCount:
        captionTracks.length,
    };
  } catch {
    return {
      text: "",
      languageCode:
        preferred
          ?.languageCode ||
        "",
      trackCount:
        captionTracks.length,
    };
  }
}

async function fetchYouTubeDataApiMetadata(
  videoId
) {
  const apiKey =
    String(
      process.env.YOUTUBE_API_KEY ||
      ""
    ).trim();

  if (!apiKey) {
    return null;
  }

  try {
    const url =
      new URL(
        "https://www.googleapis.com/youtube/v3/videos"
      );

    url.searchParams.set(
      "part",
      "snippet"
    );

    url.searchParams.set(
      "id",
      videoId
    );

    url.searchParams.set(
      "key",
      apiKey
    );

    const response =
      await fetch(
        url,
        {
          headers: {
            Accept:
              "application/json",
          },

          signal:
            AbortSignal.timeout(
              12_000
            ),
        }
      );

    if (!response.ok) {
      const responseText =
        await response.text();

      console.error(
        "YouTube Data API metadata request failed:",
        {
          status:
            response.status,

          body:
            responseText.slice(
              0,
              500
            ),
        }
      );

      return null;
    }

    const data =
      await response.json();

    const snippet =
      data?.items?.[0]
        ?.snippet;

    if (!snippet) {
      return null;
    }

    const thumbnails =
      snippet.thumbnails ||
      {};

    const thumbnailUrl =
      String(
        thumbnails.maxres?.url ||
        thumbnails.standard?.url ||
        thumbnails.high?.url ||
        thumbnails.medium?.url ||
        thumbnails.default?.url ||
        ""
      ).trim();

    return {
      title:
        String(
          snippet.title || ""
        ).trim(),

      author:
        String(
          snippet.channelTitle ||
          ""
        ).trim(),

      description:
        String(
          snippet.description ||
          ""
        ).trim(),

      thumbnailUrl,
    };
  } catch (error) {
    console.error(
      "YouTube Data API metadata request failed:",
      error
    );

    return null;
  }
}

async function resolveYouTubePage(
  sourceUrl
) {
  const validatedUrl =
    validateYouTubeUrl(
      sourceUrl
    );

  const requestedVideoId =
    extractYouTubeVideoId(
      validatedUrl
    );

  if (!requestedVideoId) {
    throw createYouTubeError(
      "Simple Dinners could not find a YouTube video ID in that link.",
      "INVALID_YOUTUBE_VIDEO_URL",
      400
    );
  }

  const canonicalUrl =
    buildCanonicalYouTubeUrl(
      requestedVideoId
    );

  let player = null;
  let pageStatus = 0;

  try {
    const response =
      await fetch(
        canonicalUrl,
        {
          headers: {
            "User-Agent":
              YOUTUBE_USER_AGENT,

            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

            "Accept-Language":
              "en-US,en;q=0.9",
          },

          redirect:
            "follow",

          signal:
            AbortSignal.timeout(
              15_000
            ),
        }
      );

    pageStatus =
      response.status;

    if (response.ok) {
      const html =
        await response.text();

      player =
        extractPlayerResponse(
          html
        );
    }
  } catch (error) {
    console.error(
      "YouTube public page metadata request failed:",
      error
    );
  }

  const details =
    player?.videoDetails ||
    {};

  const videoId =
    String(
      details.videoId ||
      requestedVideoId
    ).trim();

  const thumbnails =
    Array.isArray(
      details.thumbnail
        ?.thumbnails
    )
      ? details.thumbnail
          .thumbnails
      : [];

  const captionTracks =
    player?.captions
      ?.playerCaptionsTracklistRenderer
      ?.captionTracks ||
    [];

  let title =
    String(
      details.title || ""
    ).trim();

  let author =
    String(
      details.author || ""
    ).trim();

  let description =
    String(
      details.shortDescription ||
      ""
    ).trim();

  let thumbnailUrl =
    String(
      thumbnails.at(-1)?.url ||
      ""
    ).trim();

  let metadataSource =
    description
      ? "public-page"
      : "";

  let dataApiUsed =
    false;

  if (!description) {
    const apiMetadata =
      await fetchYouTubeDataApiMetadata(
        videoId
      );

    if (apiMetadata) {
      title =
        apiMetadata.title ||
        title;

      author =
        apiMetadata.author ||
        author;

      description =
        apiMetadata.description ||
        description;

      thumbnailUrl =
        apiMetadata.thumbnailUrl ||
        thumbnailUrl;

      metadataSource =
        "youtube-data-api";

      dataApiUsed =
        true;
    }
  }

  if (!description) {
    throw createYouTubeError(
      "This YouTube video does not include a readable public description.",
      "YOUTUBE_DESCRIPTION_UNAVAILABLE",
      422
    );
  }

  return {
    sourceUrl:
      buildCanonicalYouTubeUrl(
        videoId
      ) ||
      canonicalUrl,

    videoId,

    title,
    author,
    description,
    thumbnailUrl,

    captionTracks,

    captionTrackCount:
      captionTracks.length,

    metadataSource,

    dataApiUsed,

    publicPageStatus:
      pageStatus,

    publicPlayerFound:
      Boolean(player),
  };
}

function buildRecipeResult({
  sourceUrl,
  page,
  parsedRecipe,
  cleanText,
  slugify,
  processingPath,
  descriptionMeasurementCoverage,
  finalMeasurementCoverage,
  forceNeedsFinishing,
  partialReason,
  transcriptUsed,
  transcriptLength,
}) {
  const name =
    cleanText(
      parsedRecipe.name ||
      page.title ||
      "Imported YouTube Recipe"
    );

  const ingredients =
    parsedRecipe.ingredients;

  const instructions =
    parsedRecipe.instructions;

  const isFull =
    parsedRecipeHasUsefulContent(
      parsedRecipe
    ) &&
    !forceNeedsFinishing;

  return {
    success: true,

    successLevel:
      isFull
        ? "full"
        : "partial",

    debugVersion:
      "simple-dinners-api-youtube-import-v1",

    importMethod:
      "youtube-public-page",

    aiAssisted: true,

    readyForReview: true,

    needsFinishing:
      !isFull,

    premiumFeatureKey:
      "social-recipe-import",

    premiumEnforced: false,

    sourceUrl,
    importedFromUrl:
      sourceUrl,

    name,

    ingredients,
    instructions,

    image:
      page.thumbnailUrl,

    linkedRecipeUrl: "",

    recipe: {
      name,

      ingredients:
        ingredients.join(
          "\n"
        ),

      instructions:
        instructions.join(
          "\n"
        ),

      photoUrl:
        page.thumbnailUrl,

      slug:
        `${slugify(name)}-${Date.now()
          .toString()
          .slice(-4)}`,

      sourceUrl,

      effort:
        parsedRecipe.effort ||
        "normal",

      tags:
        Array.isArray(
          parsedRecipe.tags
        )
          ? parsedRecipe.tags
          : [],

      isVegetarian:
        parsedRecipe
          .isVegetarian ===
        true,

      notes:
        String(
          parsedRecipe.notes ||
          ""
        ).trim(),

      importStatus:
        isFull
          ? "youtube-import"
          : "youtube-import-partial",

      fallbackText:
        isFull
          ? ""
          : page.description,
    },

    youtube: {
      videoId:
        page.videoId,

      title:
        page.title,

      author:
        page.author,

      descriptionLength:
        page.description.length,

      thumbnailFound:
        Boolean(
          page.thumbnailUrl
        ),

      captionTrackCount:
        page.captionTrackCount,

      metadataSource:
        page.metadataSource,

      dataApiUsed:
        page.dataApiUsed ===
        true,
    },

    debug: {
      processingPath,

      youtubePublicPage:
        true,

      youtubeMetadataSource:
        page.metadataSource,

      youtubeDataApiUsed:
        page.dataApiUsed ===
        true,

      youtubePublicPageStatus:
        page.publicPageStatus,

      youtubePublicPlayerFound:
        page.publicPlayerFound ===
        true,

      descriptionLength:
        page.description.length,

      descriptionMeasurementCoverage,

      finalMeasurementCoverage,

      partialReason:
        isFull
          ? ""
          : partialReason,

      transcriptUsed,

      transcriptLength,

      parsedIngredientsCount:
        ingredients.length,

      parsedInstructionsCount:
        instructions.length,
    },
  };
}

export async function importRecipeFromPublicYouTubeUrl({
  sourceUrl,

  parseRecipeTextWithAI,
  cleanText,
  slugify,
  applyAiCleanupToResult,
} = {}) {
  if (
    typeof parseRecipeTextWithAI !==
    "function"
  ) {
    throw createYouTubeError(
      "The recipe parser is unavailable.",
      "YOUTUBE_RECIPE_PARSER_UNAVAILABLE",
      503
    );
  }

  const page =
    await resolveYouTubePage(
      sourceUrl
    );

  if (!page.description) {
    throw createYouTubeError(
      "This YouTube video does not include a readable public description.",
      "YOUTUBE_DESCRIPTION_UNAVAILABLE",
      422
    );
  }

  let parsedRecipe =
    normalizeParsedRecipe(
      await parseRecipeTextWithAI(
        `YouTube video title:\n${page.title}\n\nYouTube video description:\n${page.description}`
      ),

      cleanText
    );

  let processingPath =
    "description-first";

  const descriptionMeasurementCoverage =
    getMeasurementCoverage(
      parsedRecipe.ingredients
    );

  const descriptionNeedsRescue =
    !parsedRecipeHasUsefulContent(
      parsedRecipe
    ) ||
    (
      descriptionLooksLikeRecipeTeaser(
        page.description
      ) &&
      descriptionMeasurementCoverage <
        0.25
    );

  let transcriptText = "";

  if (descriptionNeedsRescue) {
    const transcript =
      await fetchCaptionTranscript(
        page.captionTracks
      );

    transcriptText =
      transcript.text;

    if (transcriptText) {
      const combinedEvidence =
        [
          `YouTube video title:\n${page.title}`,

          `YouTube video description:\n${page.description}`,

          `YouTube transcript:\n${transcriptText}`,
        ].join(
          "\n\n"
        );

      parsedRecipe =
        normalizeParsedRecipe(
          await parseRecipeTextWithAI(
            combinedEvidence
          ),

          cleanText
        );

      processingPath =
        "description-and-transcript";
    } else {
      processingPath =
        "description-only-no-transcript";
    }
  }

  const finalMeasurementCoverage =
    getMeasurementCoverage(
      parsedRecipe.ingredients
    );

  const finalNeedsFinishing =
    !parsedRecipeHasUsefulContent(
      parsedRecipe
    ) ||
    (
      descriptionLooksLikeRecipeTeaser(
        page.description
      ) &&
      finalMeasurementCoverage <
        0.25
    );

  const partialReason =
    descriptionLooksLikeRecipeTeaser(
      page.description
    ) &&
    finalMeasurementCoverage <
      0.25
      ? "youtube-teaser-missing-measurements"
      : finalNeedsFinishing
        ? "incomplete-youtube-recipe-evidence"
        : "";

  const baseResult =
    buildRecipeResult({
      sourceUrl:
        page.sourceUrl,

      page,
      parsedRecipe,
      cleanText,
      slugify,
      processingPath,

      descriptionMeasurementCoverage,

      finalMeasurementCoverage,

      forceNeedsFinishing:
        finalNeedsFinishing,

      partialReason,

      transcriptUsed:
        Boolean(
          transcriptText
        ),

      transcriptLength:
        transcriptText.length,
    });

  if (
    baseResult.successLevel !==
    "full"
  ) {
    return baseResult;
  }

  const firstPassMetadataReady =
    (
      baseResult.recipe?.effort ===
        "quick" ||
      baseResult.recipe?.effort ===
        "normal" ||
      baseResult.recipe?.effort ===
        "big"
    ) &&
    Array.isArray(
      baseResult.recipe?.tags
    ) &&
    baseResult.recipe.tags.length >
      0 &&
    baseResult.recipe.tags.every(
      (tag) =>
        typeof tag === "string" &&
        tag.trim().length > 0
    ) &&
    typeof baseResult.recipe
      ?.isVegetarian ===
      "boolean" &&
    Boolean(
      String(
        baseResult.recipe?.notes ||
        ""
      ).trim()
    );

  // A complete YouTube description has already gone
  // through the structured AI parser once. When that
  // first pass also produced usable metadata, preserve
  // the result instead of paying for a second AI cleanup.
  if (
    processingPath ===
      "description-first" &&
    firstPassMetadataReady
  ) {
    return {
      ...baseResult,

      aiCleanup: {
        enabled: false,
        skipped: true,
        reason:
          "youtube-description-full-import",
      },

      debug: {
        ...(baseResult.debug ||
          {}),

        aiCleanupSkipped: true,

        aiCleanupSkipReason:
          "youtube-description-full-import",

        firstPassMetadataReady:
          true,
      },
    };
  }

  return await applyAiCleanupToResult(
    baseResult
  );
}
