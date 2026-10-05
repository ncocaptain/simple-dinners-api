import {
  resolveTikTokCaption,
} from "./tiktokCaptionResolver.js";

import {
  cleanupTikTokVideoResolverWorkspace,
  createTikTokVideoResolverWorkspace,
  resolveTikTokVideoToFile,
} from "./tiktokPublicVideoResolver.js";

import {
  analyzeVideoRecipeEvidence,
  cleanupVideoImportWorkspace,
  prepareVideoImportInputs,
} from "./videoImportHelpers.js";

function createTikTokImportError(
  message,
  code,
  statusCode = 500
) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeLanguage(value) {
  return (
    String(value || "en")
      .trim()
      .toLowerCase()
      .slice(0, 2) || "en"
  );
}

function normalizeStringArray(
  value,
  cleanText
) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function normalizeParsedRecipe(
  parsedRecipe,
  cleanText
) {
  return {
    name: cleanText(
      parsedRecipe?.name || ""
    ),

    ingredients:
      normalizeStringArray(
        parsedRecipe?.ingredients,
        cleanText
      ),

    instructions:
      normalizeStringArray(
        parsedRecipe?.instructions,
        cleanText
      ),
  };
}

function parsedRecipeIsFull(
  parsedRecipe
) {
  return (
    parsedRecipe.ingredients.length > 0 &&
    parsedRecipe.instructions.length > 0
  );
}

function makeRecipeSlug(
  recipeName,
  slugify
) {
  return `${slugify(recipeName)}-${Date.now()
    .toString()
    .slice(-4)}`;
}

function buildTikTokMetadata(
  resolvedTikTok
) {
  return {
    found:
      Boolean(
        resolvedTikTok?.success &&
        resolvedTikTok?.captionText
      ),

    platform: "tiktok",

    originalUrl:
      String(
        resolvedTikTok?.originalUrl || ""
      ).trim(),

    expandedUrl:
      String(
        resolvedTikTok?.expandedUrl || ""
      ).trim(),

    sourceUrl:
      String(
        resolvedTikTok?.sourceUrl || ""
      ).trim(),

    captionSource:
      String(
        resolvedTikTok?.captionSource || ""
      ).trim(),

    captionText:
      String(
        resolvedTikTok?.captionText || ""
      ).trim(),

    imageUrl:
      String(
        resolvedTikTok?.imageUrl || ""
      ).trim(),

    imageWidth:
      Number(
        resolvedTikTok?.imageWidth || 0
      ),

    imageHeight:
      Number(
        resolvedTikTok?.imageHeight || 0
      ),

    authorName:
      String(
        resolvedTikTok?.authorName || ""
      ).trim(),

    authorUrl:
      String(
        resolvedTikTok?.authorUrl || ""
      ).trim(),

    authorUniqueId:
      String(
        resolvedTikTok?.authorUniqueId || ""
      ).trim(),

    videoId:
      String(
        resolvedTikTok?.videoId || ""
      ).trim(),

    providerName:
      String(
        resolvedTikTok?.providerName ||
        "TikTok"
      ).trim(),

    embedType:
      String(
        resolvedTikTok?.embedType ||
        "video"
      ).trim(),

    oembedVersion:
      String(
        resolvedTikTok?.oembedVersion || ""
      ).trim(),
  };
}

export async function importRecipeFromPublicTikTokUrl({
  sourceUrl,
  language = "en",

  openai,
  parseRecipeTextWithAI,
  cleanText,
  slugify,
  applyAiCleanupToResult,
} = {}) {
  if (!openai) {
    throw createTikTokImportError(
      "OPENAI_API_KEY is not configured.",
      "AI_UNAVAILABLE",
      503
    );
  }

  if (
    typeof parseRecipeTextWithAI !==
    "function"
  ) {
    throw createTikTokImportError(
      "The recipe text parser is unavailable.",
      "TIKTOK_RECIPE_PARSER_UNAVAILABLE"
    );
  }

  if (
    typeof cleanText !== "function"
  ) {
    throw createTikTokImportError(
      "The text cleanup helper is unavailable.",
      "TIKTOK_TEXT_CLEANER_UNAVAILABLE"
    );
  }

  if (
    typeof slugify !== "function"
  ) {
    throw createTikTokImportError(
      "The recipe slug helper is unavailable.",
      "TIKTOK_SLUG_HELPER_UNAVAILABLE"
    );
  }

  if (
    typeof applyAiCleanupToResult !==
    "function"
  ) {
    throw createTikTokImportError(
      "The recipe cleanup helper is unavailable.",
      "TIKTOK_RECIPE_CLEANUP_UNAVAILABLE"
    );
  }

  const normalizedLanguage =
    normalizeLanguage(language);

  const resolvedTikTok =
    await resolveTikTokCaption(
      sourceUrl
    );

  const tiktok =
    buildTikTokMetadata(
      resolvedTikTok
    );

  if (!tiktok.captionText) {
    throw createTikTokImportError(
      "TikTok did not provide enough recipe text for this public video.",
      "TIKTOK_CAPTION_UNAVAILABLE",
      422
    );
  }

  const recipeEvidence =
    `TikTok caption:\n${tiktok.captionText}`;

  let combinedRecipeEvidence =
    recipeEvidence;

  const parsedFromCaption =
    await parseRecipeTextWithAI(
      recipeEvidence,
      {
        language:
          normalizedLanguage,
      }
    );

  let parsedRecipe =
    normalizeParsedRecipe(
      parsedFromCaption,
      cleanText
    );

  let resolvedVideo = null;
  let videoResolveError = null;
  let preparedVideo = null;
  let videoEvidence = null;

  if (
    !parsedRecipeIsFull(
      parsedRecipe
    )
  ) {
    const resolverWorkspace =
      await createTikTokVideoResolverWorkspace();

    try {
      resolvedVideo =
        await resolveTikTokVideoToFile(
          tiktok.sourceUrl ||
            tiktok.expandedUrl ||
            sourceUrl,
          {
            workspaceDir:
              resolverWorkspace,
          }
        );

      preparedVideo =
        await prepareVideoImportInputs(
          resolvedVideo.outputPath,
          {
            openai,
            language:
              normalizedLanguage,
          }
        );

      videoEvidence =
        await analyzeVideoRecipeEvidence(
          {
            framePaths:
              preparedVideo.framePaths,
            transcriptText:
              preparedVideo.transcriptText,
          },
          {
            openai,
            language:
              normalizedLanguage,
          }
        );

      const videoEvidenceText =
        videoEvidence
          ?.hasRecipeContent
          ? String(
              videoEvidence
                .combinedRecipeText ||
              ""
            ).trim()
          : "";

      if (
        videoEvidenceText
      ) {
        combinedRecipeEvidence = [
          recipeEvidence,
          `Video evidence:\n${videoEvidenceText}`,
        ]
          .filter(Boolean)
          .join("\n\n")
          .trim();

        const parsedCombined =
          await parseRecipeTextWithAI(
            combinedRecipeEvidence,
            {
              language:
                normalizedLanguage,
            }
          );

        parsedRecipe =
          normalizeParsedRecipe(
            parsedCombined,
            cleanText
          );
      }
    } catch (error) {
      videoResolveError =
        error;
    } finally {
      if (
        preparedVideo
          ?.workspaceDir
      ) {
        await cleanupVideoImportWorkspace(
          preparedVideo.workspaceDir
        );
      }

      await cleanupTikTokVideoResolverWorkspace(
        resolverWorkspace
      );
    }
  }

  const recipeName = cleanText(
    parsedRecipe.name ||
      "Imported TikTok Recipe"
  );

  const recipeSlug =
    makeRecipeSlug(
      recipeName,
      slugify
    );

  const sourceResultUrl =
    tiktok.sourceUrl ||
    tiktok.expandedUrl ||
    String(sourceUrl || "").trim();

  const photoUrl =
    tiktok.imageUrl || "";

  const debug = {
    publicTikTokImport: true,
    captionImport: true,
    processingPath:
      parsedRecipeIsFull(
        parsedRecipe
      )
        ? resolvedVideo
          ? "tiktok-caption-and-video"
          : "tiktok-caption-first-full"
        : resolvedVideo
          ? "tiktok-caption-and-video-partial"
          : videoResolveError
            ? "tiktok-caption-only-video-unavailable"
            : "tiktok-caption-first-partial",

    language:
      normalizedLanguage,

    captionEvidenceLength:
      tiktok.captionText.length,

    combinedEvidenceLength:
      combinedRecipeEvidence.length,

    videoImport:
      Boolean(
        resolvedVideo
      ),

    videoAvailable:
      Boolean(
        resolvedVideo
      ),

    transcriptLength:
      String(
        preparedVideo?.transcriptText ||
        ""
      ).length,

    parsedIngredientsCount:
      parsedRecipe.ingredients.length,

    parsedInstructionsCount:
      parsedRecipe.instructions.length,
  };

  const evidence = {
    platform: "tiktok",

    captionUsed: true,

    captionSource:
      tiktok.captionSource,

    captionText:
      tiktok.captionText,

    combinedRecipeText:
      combinedRecipeEvidence,

    videoAvailable:
      Boolean(
        resolvedVideo
      ),

    videoError:
      videoResolveError instanceof Error
        ? videoResolveError.message
        : "",

    possibleMissingContent:
      !parsedRecipeIsFull(
        parsedRecipe
      ),

    warnings:
      parsedRecipeIsFull(
        parsedRecipe
      )
        ? []
        : [
            "The TikTok caption did not contain a complete ingredient list and cooking method.",
          ],
  };

  if (
    !parsedRecipeIsFull(
      parsedRecipe
    )
  ) {
    return {
      success: true,
      successLevel: "partial",

      debugVersion:
        "simple-dinners-api-public-tiktok-import-v1",

      importMethod:
        "ai-public-video",

      aiAssisted: true,
      readyForReview: true,
      needsFinishing: true,

      reviewWarning:
        "Simple Dinners found part of this TikTok recipe. Review what was recovered and fill in anything missing.",

      premiumFeatureKey:
        "ai_video_import",

      premiumEnforced: false,

      platform: "tiktok",

      sourceUrl:
        sourceResultUrl,

      importedFromUrl:
        sourceResultUrl,

      name:
        recipeName,

      ingredients:
        parsedRecipe.ingredients,

      instructions:
        parsedRecipe.instructions,

      image:
        photoUrl,

      linkedRecipeUrl: "",

      recipe: {
        name:
          recipeName,

        ingredients:
          parsedRecipe.ingredients.join(
            "\n"
          ),

        instructions:
          parsedRecipe.instructions.join(
            "\n"
          ),

        photoUrl,

        slug:
          recipeSlug,

        sourceUrl:
          sourceResultUrl,

        effort: "normal",

        importStatus:
          "public-video-import-partial",

        fallbackText:
          combinedRecipeEvidence,
      },

      tiktok,

      resolvedTikTokVideo:
        resolvedVideo
          ? {
              available: true,
              sizeBytes:
                resolvedVideo.sizeBytes,
              candidateCount:
                resolvedVideo.candidateCount,
              resolver:
                resolvedVideo.resolver,
            }
          : {
              available: false,
              sizeBytes: 0,
              candidateCount: 0,
              resolver: "",
              error:
                videoResolveError instanceof Error
                  ? videoResolveError.message
                  : "",
            },

      transcriptText:
        String(
          preparedVideo?.transcriptText ||
          ""
        ),

      evidence,
      debug,
    };
  }

  const roughRecipe = {
    name:
      recipeName,

    ingredients:
      parsedRecipe.ingredients.join(
        "\n"
      ),

    instructions:
      parsedRecipe.instructions.join(
        "\n"
      ),

    photoUrl,

    slug:
      recipeSlug,

    sourceUrl:
      sourceResultUrl,

    effort: "normal",

    importStatus:
      "public-video-import",

    fallbackText: "",
  };

  const publicTikTokImportResult = {
    success: true,
    successLevel: "full",

    debugVersion:
      "simple-dinners-api-public-tiktok-import-v1",

    importMethod:
      "ai-public-video",

    aiAssisted: true,
    readyForReview: true,

    premiumFeatureKey:
      "ai_video_import",

    premiumEnforced: false,

    platform: "tiktok",

    sourceUrl:
      sourceResultUrl,

    importedFromUrl:
      sourceResultUrl,

    name:
      recipeName,

    ingredients:
      parsedRecipe.ingredients,

    instructions:
      parsedRecipe.instructions,

    image:
      photoUrl,

    linkedRecipeUrl: "",

    recipe:
      roughRecipe,

    tiktok,

    resolvedTikTokVideo:
      resolvedVideo
        ? {
            available: true,
            sizeBytes:
              resolvedVideo.sizeBytes,
            candidateCount:
              resolvedVideo.candidateCount,
            resolver:
              resolvedVideo.resolver,
          }
        : {
            available: false,
            sizeBytes: 0,
            candidateCount: 0,
            resolver: "",
            error:
              videoResolveError instanceof Error
                ? videoResolveError.message
                : "",
          },

    transcriptText:
      String(
        preparedVideo?.transcriptText ||
        ""
      ),

    evidence,
    debug,
  };

  const cleanedResult =
    await applyAiCleanupToResult(
      publicTikTokImportResult
    );

  return {
    ...cleanedResult,

    success: true,
    successLevel: "full",

    debugVersion:
      "simple-dinners-api-public-tiktok-import-v1",

    importMethod:
      "ai-public-video",

    aiAssisted: true,
    readyForReview: true,

    premiumFeatureKey:
      "ai_video_import",

    premiumEnforced: false,

    platform: "tiktok",

    sourceUrl:
      cleanedResult?.sourceUrl ||
      sourceResultUrl,

    importedFromUrl:
      cleanedResult?.importedFromUrl ||
      sourceResultUrl,

    image:
      cleanedResult?.image ||
      photoUrl,

    tiktok,

    resolvedTikTokVideo:
      publicTikTokImportResult
        .resolvedTikTokVideo,

    transcriptText:
      publicTikTokImportResult
        .transcriptText,

    evidence,
    debug: {
      ...debug,
      ...(cleanedResult?.debug || {}),
    },
  };
}
