import {
  cleanupPublicVideoResolverWorkspace,
  createPublicVideoResolverWorkspace,
  resolvePublicVideoToFile,
} from "./publicVideoResolver.js";

import {
  analyzeVideoRecipeEvidence,
  cleanupVideoImportWorkspace,
  prepareVideoImportInputs,
} from "./videoImportHelpers.js";

import {
  resolveInstagramCaption,
} from "./instagramCaptionResolver.js";

function createPipelineError(message, code, statusCode = 500) {
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

function normalizeStringArray(value, cleanText) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function makeRecipeSlug(recipeName, slugify) {
  return `${slugify(recipeName)}-${Date.now()
    .toString()
    .slice(-4)}`;
}

function createEmptyVideoEvidence() {
  return {
    hasRecipeContent: false,
    title: "",
    titleSource: "",
    visibleRecipeText: "",
    spokenRecipeText: "",
    combinedRecipeText: "",
    ingredientsAppearComplete: false,
    instructionsAppearComplete: false,
    possibleMissingContent: true,
    warnings: [],
  };
}

function buildVideoMetadata({
  preparedVideo,
  error,
}) {
  if (!preparedVideo) {
    return {
      filename: "",
      mimetype: "",
      frameCount: 0,
      hasAudio: false,
      available: false,
      error:
        error instanceof Error
          ? error.message
          : "",
    };
  }

  return {
    filename:
      "resolved-instagram-video.mp4",
    mimetype: "video/mp4",
    frameCount:
      preparedVideo.frameCount,
    hasAudio:
      preparedVideo.hasAudio,
    available: true,
    error: "",
  };
}

function buildEvidenceMetadata(
  videoEvidence
) {
  return {
    title: videoEvidence.title,
    titleSource:
      videoEvidence.titleSource,
    visibleRecipeText:
      videoEvidence.visibleRecipeText,
    spokenRecipeText:
      videoEvidence.spokenRecipeText,
    combinedRecipeText:
      videoEvidence.combinedRecipeText,
    ingredientsAppearComplete:
      videoEvidence.ingredientsAppearComplete,
    instructionsAppearComplete:
      videoEvidence.instructionsAppearComplete,
    possibleMissingContent:
      videoEvidence.possibleMissingContent,
    warnings:
      Array.isArray(
        videoEvidence.warnings
      )
        ? videoEvidence.warnings
        : [],
  };
}

function buildResolvedPublicVideoMetadata(
  resolvedVideo,
  error
) {
  if (!resolvedVideo) {
    return {
      platform: "instagram",
      available: false,
      durationSeconds: 0,
      sizeBytes: 0,
      hasAudio: false,
      candidateCount: 0,
      uniqueTrackCount: 0,
      error:
        error instanceof Error
          ? error.message
          : "",
    };
  }

  return {
    platform:
      resolvedVideo.platform,
    available: true,
    durationSeconds:
      resolvedVideo.durationSeconds,
    sizeBytes:
      resolvedVideo.sizeBytes,
    hasAudio:
      resolvedVideo.hasAudio,
    candidateCount:
      resolvedVideo.candidateCount,
    uniqueTrackCount:
      resolvedVideo.uniqueTrackCount,
    error: "",
  };
}

function buildInstagramCaptionMetadata(
  captionResult,
  captionError
) {
  return {
    found:
      Boolean(
        captionResult?.success &&
        captionResult?.captionText
      ),

    source:
      captionResult?.captionSource || "",
    sourceUrl:
      String(
        captionResult?.sourceUrl || ""
      ).trim(),
    finalUrl:
      String(
        captionResult?.finalUrl || ""
      ).trim(),
    navigationStatus:
      captionResult?.navigationStatus ??
      null,

    score:
      Number(
        captionResult?.captionScore || 0
      ),

    text:
      String(
        captionResult?.captionText || ""
      ).trim(),

    imageUrl:
      String(
        captionResult?.imageUrl || ""
      ).trim(),

    candidateCount:
      Number(
        captionResult?.candidateCount || 0
      ),

    error:
      captionError instanceof Error
        ? captionError.message
        : "",
  };
}

function buildCombinedPublicRecipeEvidence({
  captionText,
  videoEvidenceText,
}) {
  const sections = [];

  if (captionText) {
    sections.push(
      `Instagram caption:\n${captionText}`
    );
  }

  if (videoEvidenceText) {
    sections.push(
      `Video evidence:\n${videoEvidenceText}`
    );
  }

  return sections.join("\n\n").trim();
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

const MIN_TEASER_MEASUREMENT_COVERAGE =
  0.25;

function ingredientHasExplicitAmount(
  value
) {
  const text =
    String(value || "").trim();

  if (
    !text ||
    text.endsWith(":")
  ) {
    return false;
  }

  return /^(?:about\s+|approx(?:imately)?\.?\s+|around\s+|roughly\s+)?(?:(?:\d+\s+\d+\/\d+)|(?:\d+\/\d+)|(?:\d+(?:\.\d+)?)|[¼½¾⅓⅔⅛⅜⅝⅞]|(?:one|two|three|four|five|six|seven|eight|nine|ten))(?=\s|\(|$)/i.test(
    text
  );
}

function getIngredientMeasurementCoverage(
  ingredients
) {
  const ingredientLines =
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

  if (
    ingredientLines.length === 0
  ) {
    return 0;
  }

  const measuredCount =
    ingredientLines.filter(
      ingredientHasExplicitAmount
    ).length;

  return (
    measuredCount /
    ingredientLines.length
  );
}

function captionLooksLikeRecipeTeaser(
  value
) {
  const text =
    String(value || "");

  return (
    /(?:^|\n)\s*#{0,3}\s*short recipe\b/i.test(
      text
    ) ||
    /\bfull step[-\s]?by[-\s]?step\b/i.test(
      text
    ) ||
    /\b(?:full|complete)\s+recipe\b[\s\S]{0,100}\b(?:bio|link|comment|website)\b/i.test(
      text
    ) ||
    /\b(?:link|recipe)\s+in\s+(?:my\s+)?bio\b/i.test(
      text
    ) ||
    /\bcomment\s+['"“”‘’]?recipe['"“”‘’]?\b/i.test(
      text
    )
  );
}

export async function importRecipeFromPublicVideoUrl({
  sourceUrl,
  language = "en",

  openai,
  parseRecipeTextWithAI,
  cleanText,
  slugify,
  applyAiCleanupToResult,

  frameIntervalSeconds = 2,
  maxFrames = 12,
  frameWidth = 720,
} = {}) {
  if (!openai) {
    throw createPipelineError(
      "OPENAI_API_KEY is not configured.",
      "AI_UNAVAILABLE",
      503
    );
  }

  if (
    typeof parseRecipeTextWithAI !==
    "function"
  ) {
    throw createPipelineError(
      "The recipe text parser is unavailable.",
      "VIDEO_RECIPE_PARSER_UNAVAILABLE"
    );
  }

  if (
    typeof cleanText !== "function"
  ) {
    throw createPipelineError(
      "The text cleanup helper is unavailable.",
      "VIDEO_TEXT_CLEANER_UNAVAILABLE"
    );
  }

  if (
    typeof slugify !== "function"
  ) {
    throw createPipelineError(
      "The recipe slug helper is unavailable.",
      "VIDEO_SLUG_HELPER_UNAVAILABLE"
    );
  }

  if (
    typeof applyAiCleanupToResult !==
    "function"
  ) {
    throw createPipelineError(
      "The recipe cleanup helper is unavailable.",
      "VIDEO_RECIPE_CLEANUP_UNAVAILABLE"
    );
  }

  const normalizedLanguage =
    normalizeLanguage(language);

  const publicVideoWorkspace =
    await createPublicVideoResolverWorkspace();

  let preparedVideo = null;
  let resolvedVideo = null;
  let videoResolveError = null;

  let captionResult = null;
  let captionError = null;

  let videoEvidence =
    createEmptyVideoEvidence();

  try {
    // ---------------------------------------------------
    // Layer 1: Instagram caption
    // This is the fastest and most reliable source when
    // the creator included the complete recipe in text.
    // ---------------------------------------------------

    try {
      captionResult =
        await resolveInstagramCaption(
          sourceUrl
        );
    } catch (error) {
      captionError = error;
    }

    const instagramCaption =
      buildInstagramCaptionMetadata(
        captionResult,
        captionError
      );

    const captionEvidence =
      instagramCaption.text
        ? `Instagram caption:\n${instagramCaption.text}`
        : "";

    let parsedRecipe =
      normalizeParsedRecipe(
        null,
        cleanText
      );

    let combinedRecipeEvidence =
      captionEvidence;

    let processingPath =
      "caption-unavailable";

    let captionLooksIncomplete =
      false;

    let captionMeasurementCoverage =
      0;

    let captionNeedsVideoRescue =
      false;

    if (captionEvidence) {
      const parsedCaption =
        await parseRecipeTextWithAI(
          captionEvidence
        );

      parsedRecipe =
        normalizeParsedRecipe(
          parsedCaption,
          cleanText
        );

      captionLooksIncomplete =
        captionLooksLikeRecipeTeaser(
          instagramCaption.text
        );

      captionMeasurementCoverage =
        getIngredientMeasurementCoverage(
          parsedRecipe.ingredients
        );

      captionNeedsVideoRescue =
        parsedRecipeIsFull(
          parsedRecipe
        ) &&
        captionLooksIncomplete &&
        captionMeasurementCoverage <
          MIN_TEASER_MEASUREMENT_COVERAGE;

      processingPath =
        parsedRecipeIsFull(
          parsedRecipe
        ) &&
        !captionNeedsVideoRescue
          ? "caption-first-full"
          : "caption-first-partial";
    }

    // ---------------------------------------------------
    // Layer 2: Public video
    // Only needed when the caption did not already supply
    // a complete ingredient list and cooking method.
    // Failure is nonfatal when caption evidence exists.
    // ---------------------------------------------------

    if (
      !parsedRecipeIsFull(
        parsedRecipe
      ) ||
      captionNeedsVideoRescue
    ) {
      try {
        resolvedVideo =
          await resolvePublicVideoToFile(
            sourceUrl,
            {
              workspaceDir:
                publicVideoWorkspace,
            }
          );

        preparedVideo =
          await prepareVideoImportInputs(
            resolvedVideo.outputPath,
            {
              openai,
              language:
                normalizedLanguage,
              frameIntervalSeconds,
              maxFrames,
              frameWidth,
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
          videoEvidence.hasRecipeContent
            ? String(
                videoEvidence.combinedRecipeText ||
                ""
              ).trim()
            : "";

        combinedRecipeEvidence =
          buildCombinedPublicRecipeEvidence({
            captionText:
              instagramCaption.text,
            videoEvidenceText,
          });

        if (
          combinedRecipeEvidence
        ) {
          const parsedCombined =
            await parseRecipeTextWithAI(
              combinedRecipeEvidence
            );

          parsedRecipe =
            normalizeParsedRecipe(
              parsedCombined,
              cleanText
            );

          captionNeedsVideoRescue =
            captionLooksIncomplete &&
            getIngredientMeasurementCoverage(
              parsedRecipe.ingredients
            ) <
              MIN_TEASER_MEASUREMENT_COVERAGE;
        }

        processingPath =
          instagramCaption.text
            ? "caption-and-video"
            : "video-only";
      } catch (error) {
        videoResolveError = error;

        processingPath =
          instagramCaption.text
            ? "caption-only-video-unavailable"
            : "video-unavailable";
      }
    }

    if (!combinedRecipeEvidence) {
      const error = createPipelineError(
        "Simple Dinners could not find enough recipe information in that Instagram post or video.",
        "PUBLIC_VIDEO_NO_RECIPE_FOUND",
        422
      );

      error.details = {
        instagramCaption,

        resolvedPublicVideo:
          buildResolvedPublicVideoMetadata(
            resolvedVideo,
            videoResolveError
          ),

        video:
          buildVideoMetadata({
            preparedVideo,
            error:
              videoResolveError,
          }),

        transcriptText:
          preparedVideo?.transcriptText ||
          "",

        evidence:
          buildEvidenceMetadata(
            videoEvidence
          ),
      };

      throw error;
    }

    const recipeName = cleanText(
      parsedRecipe.name ||
        videoEvidence.title ||
        "Imported Video Recipe"
    );

    const recipeSlug =
      makeRecipeSlug(
        recipeName,
        slugify
      );

    const sourceResultUrl =
      String(
        captionResult?.sourceUrl ||
        resolvedVideo?.sourceUrl ||
        sourceUrl ||
        ""
      ).trim();

    const photoUrl =
      instagramCaption.imageUrl ||
      "";

    const videoMetadata =
      buildVideoMetadata({
        preparedVideo,
        error:
          videoResolveError,
      });

    const resolvedPublicVideo =
      buildResolvedPublicVideoMetadata(
        resolvedVideo,
        videoResolveError
      );

    const transcriptText =
      preparedVideo?.transcriptText ||
      "";

    const videoEvidenceText =
      videoEvidence.hasRecipeContent
        ? String(
            videoEvidence.combinedRecipeText ||
            ""
          ).trim()
        : "";

    const evidenceWarnings = [
      ...(
        Array.isArray(
          videoEvidence.warnings
        )
          ? videoEvidence.warnings
          : []
      ),
    ];

    if (
      videoResolveError &&
      instagramCaption.text
    ) {
      evidenceWarnings.push(
        "The public video could not be accessed in this environment, so the recipe was built from the Instagram caption."
      );
    }

    const evidenceMetadata = {
      ...buildEvidenceMetadata(
        videoEvidence
      ),

      captionUsed:
        Boolean(
          instagramCaption.text
        ),

      instagramCaption,

      combinedRecipeText:
        combinedRecipeEvidence,

      videoAvailable:
        Boolean(resolvedVideo),

      videoError:
        videoResolveError instanceof Error
          ? videoResolveError.message
          : "",

      warnings:
        evidenceWarnings,
    };

    const finalMeasurementCoverage =
      getIngredientMeasurementCoverage(
        parsedRecipe.ingredients
      );

    const finalNeedsFinishing =
      !parsedRecipeIsFull(
        parsedRecipe
      ) ||
      (
        captionLooksIncomplete &&
        finalMeasurementCoverage <
          MIN_TEASER_MEASUREMENT_COVERAGE
      );

    if (
      finalNeedsFinishing &&
      resolvedVideo &&
      processingPath ===
        "caption-and-video"
    ) {
      processingPath =
        "caption-and-video-partial";
    }

    const baseDebug = {
      publicVideoImport: true,

      videoImport:
        Boolean(resolvedVideo),

      captionImport:
        Boolean(
          instagramCaption.text
        ),

      processingPath,

      evidenceExtracted:
        Boolean(
          combinedRecipeEvidence
        ),

      originalTranscriptLength:
        transcriptText.length,

      combinedEvidenceLength:
        combinedRecipeEvidence.length,

      captionEvidenceLength:
        instagramCaption.text.length,

      videoEvidenceLength:
        videoEvidenceText.length,

      parsedIngredientsCount:
        parsedRecipe.ingredients.length,

      parsedInstructionsCount:
        parsedRecipe.instructions.length,

      captionLooksIncomplete,

      captionMeasurementCoverage,

      finalMeasurementCoverage,

      captionNeedsVideoRescue,
    };

    if (
      finalNeedsFinishing
    ) {
      return {
        success: true,
        successLevel: "partial",

        debugVersion:
          "simple-dinners-api-public-video-import-v3",

        importMethod:
          "ai-public-video",
        aiAssisted: true,
        readyForReview: true,
        needsFinishing: true,

        reviewWarning:
          "Simple Dinners found part of this recipe. Review what was recovered and fill in anything missing.",

        premiumFeatureKey:
          "ai_video_import",
        premiumEnforced: false,

        sourceUrl:
          sourceResultUrl,
        importedFromUrl:
          sourceResultUrl,

        name: recipeName,
        ingredients:
          parsedRecipe.ingredients,
        instructions:
          parsedRecipe.instructions,

        image: photoUrl,
        linkedRecipeUrl: "",

        recipe: {
          name: recipeName,

          ingredients:
            parsedRecipe.ingredients.join(
              "\n"
            ),

          instructions:
            parsedRecipe.instructions.join(
              "\n"
            ),

          photoUrl,
          slug: recipeSlug,

          sourceUrl:
            sourceResultUrl,

          effort: "normal",

          importStatus:
            "public-video-import-partial",

          fallbackText:
            combinedRecipeEvidence,
        },

        resolvedPublicVideo,
        instagramCaption,
        video: videoMetadata,
        transcriptText,

        evidence: {
          ...evidenceMetadata,
          possibleMissingContent: true,
          warnings: [
            ...evidenceMetadata.warnings,
            "The available Instagram evidence did not contain a complete ingredient list and cooking method.",
          ],
        },

        debug: {
          ...baseDebug,
          partialRecipe: true,

          partialReason:
            captionLooksIncomplete &&
            finalMeasurementCoverage <
              MIN_TEASER_MEASUREMENT_COVERAGE
              ? "instagram-teaser-missing-measurements"
              : "incomplete-recipe-evidence",
        },
      };
    }

    const roughRecipe = {
      name: recipeName,

      ingredients:
        parsedRecipe.ingredients.join(
          "\n"
        ),

      instructions:
        parsedRecipe.instructions.join(
          "\n"
        ),

      photoUrl,
      slug: recipeSlug,

      sourceUrl:
        sourceResultUrl,

      effort: "normal",

      importStatus:
        "public-video-import",

      fallbackText: "",
    };

    const publicVideoImportResult = {
      success: true,
      successLevel: "full",

      debugVersion:
        "simple-dinners-api-public-video-import-v3",

      importMethod:
        "ai-public-video",

      aiAssisted: true,
      readyForReview: true,

      premiumFeatureKey:
        "ai_video_import",

      premiumEnforced: false,

      sourceUrl:
        sourceResultUrl,

      importedFromUrl:
        sourceResultUrl,

      name: recipeName,

      ingredients:
        parsedRecipe.ingredients,

      instructions:
        parsedRecipe.instructions,

      image: photoUrl,
      linkedRecipeUrl: "",

      recipe: roughRecipe,

      resolvedPublicVideo,
      instagramCaption,
      video: videoMetadata,
      transcriptText,

      evidence:
        evidenceMetadata,

      debug:
        baseDebug,
    };

    const cleanedResult =
      await applyAiCleanupToResult(
        publicVideoImportResult
      );

    return {
      ...cleanedResult,

      success: true,
      successLevel: "full",

      debugVersion:
        "simple-dinners-api-public-video-import-v3",

      importMethod:
        "ai-public-video",

      aiAssisted: true,
      readyForReview: true,

      premiumFeatureKey:
        "ai_video_import",

      premiumEnforced: false,

      resolvedPublicVideo,
      instagramCaption,

      image:
        cleanedResult?.image ||
        photoUrl,

      video: videoMetadata,
      transcriptText,

      evidence:
        evidenceMetadata,
    };
  } finally {
    if (
      preparedVideo?.workspaceDir
    ) {
      await cleanupVideoImportWorkspace(
        preparedVideo.workspaceDir
      );
    }

    await cleanupPublicVideoResolverWorkspace(
      publicVideoWorkspace
    );
  }
}
