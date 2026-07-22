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
  return String(value || "en")
    .trim()
    .toLowerCase()
    .slice(0, 2) || "en";
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

function buildVideoMetadata({
  filename,
  mimetype,
  preparedVideo,
}) {
  return {
    filename,
    mimetype,
    frameCount: preparedVideo.frameCount,
    hasAudio: preparedVideo.hasAudio,
  };
}

function buildEvidenceMetadata(videoEvidence) {
  return {
    title: videoEvidence.title,
    titleSource: videoEvidence.titleSource,
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
    warnings: videoEvidence.warnings,
  };
}

function buildResolvedPublicVideoMetadata(resolvedVideo) {
  return {
    platform: resolvedVideo.platform,
    durationSeconds:
      resolvedVideo.durationSeconds,
    sizeBytes: resolvedVideo.sizeBytes,
    hasAudio: resolvedVideo.hasAudio,
    candidateCount:
      resolvedVideo.candidateCount,
    uniqueTrackCount:
      resolvedVideo.uniqueTrackCount,
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

  if (typeof parseRecipeTextWithAI !== "function") {
    throw createPipelineError(
      "The recipe text parser is unavailable.",
      "VIDEO_RECIPE_PARSER_UNAVAILABLE"
    );
  }

  if (typeof cleanText !== "function") {
    throw createPipelineError(
      "The text cleanup helper is unavailable.",
      "VIDEO_TEXT_CLEANER_UNAVAILABLE"
    );
  }

  if (typeof slugify !== "function") {
    throw createPipelineError(
      "The recipe slug helper is unavailable.",
      "VIDEO_SLUG_HELPER_UNAVAILABLE"
    );
  }

  if (typeof applyAiCleanupToResult !== "function") {
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
  let captionResult = null;
  let captionError = null;

  try {
    try {
      captionResult =
        await resolveInstagramCaption(
          sourceUrl
        );
    } catch (error) {
      captionError = error;
    }

    const resolvedVideo =
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

    const videoEvidence =
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

    const instagramCaption =
      buildInstagramCaptionMetadata(
        captionResult,
        captionError
      );

    const videoEvidenceText =
      videoEvidence.hasRecipeContent
        ? String(
            videoEvidence.combinedRecipeText ||
            ""
          ).trim()
        : "";

    const combinedRecipeEvidence =
      buildCombinedPublicRecipeEvidence({
        captionText:
          instagramCaption.text,
        videoEvidenceText,
      });

    if (!combinedRecipeEvidence) {
      const error = createPipelineError(
        "Simple Dinners could not find enough recipe information in that Instagram post or video.",
        "PUBLIC_VIDEO_NO_RECIPE_FOUND",
        422
      );

      error.details = {
        resolvedPublicVideo:
          buildResolvedPublicVideoMetadata(
            resolvedVideo
          ),

        instagramCaption,

        video: buildVideoMetadata({
          filename:
            "resolved-instagram-video.mp4",
          mimetype: "video/mp4",
          preparedVideo,
        }),

        transcriptText:
          preparedVideo.transcriptText,

        evidence:
          buildEvidenceMetadata(
            videoEvidence
          ),
      };

      throw error;
    }

    const parsedVideoRecipe =
      await parseRecipeTextWithAI(
        combinedRecipeEvidence
      );

    const recipeName = cleanText(
      parsedVideoRecipe?.name ||
        videoEvidence.title ||
        "Imported Video Recipe"
    );

    const parsedIngredients =
      normalizeStringArray(
        parsedVideoRecipe?.ingredients,
        cleanText
      );

    const parsedInstructions =
      normalizeStringArray(
        parsedVideoRecipe?.instructions,
        cleanText
      );

    const recipeSlug =
      makeRecipeSlug(
        recipeName,
        slugify
      );

    const videoMetadata =
      buildVideoMetadata({
        filename:
          "resolved-instagram-video.mp4",
        mimetype: "video/mp4",
        preparedVideo,
      });

    const photoUrl =
      instagramCaption.imageUrl || "";

    const evidenceMetadata = {
      ...buildEvidenceMetadata(
        videoEvidence
      ),

      captionUsed:
        Boolean(instagramCaption.text),

      instagramCaption,

      combinedRecipeText:
        combinedRecipeEvidence,
    };

    const resolvedPublicVideo =
      buildResolvedPublicVideoMetadata(
        resolvedVideo
      );

    if (
      parsedIngredients.length === 0 ||
      parsedInstructions.length === 0
    ) {
      return {
        success: true,
        successLevel: "partial",

        debugVersion:
          "simple-dinners-api-public-video-import-v2",

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
          resolvedVideo.sourceUrl,
        importedFromUrl:
          resolvedVideo.sourceUrl,

        name: recipeName,
        ingredients:
          parsedIngredients,
        instructions:
          parsedInstructions,

        image: photoUrl,
        linkedRecipeUrl: "",

        recipe: {
          name: recipeName,
          ingredients:
            parsedIngredients.join("\n"),
          instructions:
            parsedInstructions.join("\n"),
          photoUrl,
          slug: recipeSlug,
          sourceUrl:
            resolvedVideo.sourceUrl,
          effort: "normal",
          importStatus:
            "public-video-import-partial",
          fallbackText:
            combinedRecipeEvidence,
        },

        resolvedPublicVideo,
        instagramCaption,
        video: videoMetadata,

        transcriptText:
          preparedVideo.transcriptText,

        evidence: {
          ...evidenceMetadata,
          possibleMissingContent: true,
          warnings: [
            ...evidenceMetadata.warnings,
            "The video did not contain a complete ingredient list and cooking method.",
          ],
        },

        debug: {
          publicVideoImport: true,
          videoImport: true,
          evidenceExtracted: true,
          partialRecipe: true,

          originalTranscriptLength:
            preparedVideo.transcriptText.length,

          combinedEvidenceLength:
            combinedRecipeEvidence.length,

          captionEvidenceLength:
            instagramCaption.text.length,

          videoEvidenceLength:
            videoEvidenceText.length,

          parsedIngredientsCount:
            parsedIngredients.length,

          parsedInstructionsCount:
            parsedInstructions.length,
        },
      };
    }

    const roughRecipe = {
      name: recipeName,
      ingredients:
        parsedIngredients.join("\n"),
      instructions:
        parsedInstructions.join("\n"),
      photoUrl,
      slug: recipeSlug,
      sourceUrl:
        resolvedVideo.sourceUrl,
      effort: "normal",
      importStatus:
        "public-video-import",
      fallbackText: "",
    };

    const publicVideoImportResult = {
      success: true,
      successLevel: "full",

      debugVersion:
        "simple-dinners-api-public-video-import-v2",

      importMethod:
        "ai-public-video",
      aiAssisted: true,
      readyForReview: true,

      premiumFeatureKey:
        "ai_video_import",
      premiumEnforced: false,

      sourceUrl:
        resolvedVideo.sourceUrl,
      importedFromUrl:
        resolvedVideo.sourceUrl,

      name: recipeName,
      ingredients:
        parsedIngredients,
      instructions:
        parsedInstructions,

      image: photoUrl,
      linkedRecipeUrl: "",

      recipe: roughRecipe,

      resolvedPublicVideo,
      instagramCaption,
      video: videoMetadata,

      transcriptText:
        preparedVideo.transcriptText,

      evidence:
        evidenceMetadata,

      debug: {
        publicVideoImport: true,
        videoImport: true,
        evidenceExtracted: true,

        originalTranscriptLength:
          preparedVideo.transcriptText.length,

        combinedEvidenceLength:
          combinedRecipeEvidence.length,

        captionEvidenceLength:
          instagramCaption.text.length,

        videoEvidenceLength:
          videoEvidenceText.length,

        parsedIngredientsCount:
          parsedIngredients.length,

        parsedInstructionsCount:
          parsedInstructions.length,
      },
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
        "simple-dinners-api-public-video-import-v2",

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

      transcriptText:
        preparedVideo.transcriptText,

      evidence:
        evidenceMetadata,
    };
  } finally {
    if (preparedVideo?.workspaceDir) {
      await cleanupVideoImportWorkspace(
        preparedVideo.workspaceDir
      );
    }

    await cleanupPublicVideoResolverWorkspace(
      publicVideoWorkspace
    );
  }
}
