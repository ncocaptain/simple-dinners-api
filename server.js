// =====================================================
// Simple Dinners API
// Backend importer using Fastify + Playwright + Cheerio
// =====================================================
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import {
  resolvePinterestRecipeUrl,
  isPinterestRecipeCandidate,
} from "./pinterestResolver.js";
import {
  resolveSocialCaptionParts,
  chooseSocialRecipeTitle,
} from "./socialCaptionResolver.js";

// =====================================================
// App setup
// =====================================================

const app = Fastify({ logger: true });
await app.register(multipart, {
  limits: {
    files: 5,
    fileSize: 8 * 1024 * 1024,
    parts: 10,
  },
});
app.addHook("onRequest", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
});

app.options("/*", async (request, reply) => {
  return reply.code(204).send();
});

const openaiApiKey = process.env.OPENAI_API_KEY;

const openai = openaiApiKey
  ? new OpenAI({
    apiKey: openaiApiKey,
  })
  : null;

if (!openaiApiKey) {
  console.warn(
    "OPENAI_API_KEY is not set. AI cleanup will be unavailable locally, but non-AI routes can still run."
  );
}

const SOURCE_STEPS_PLACEHOLDER = "Steps available at source link!";

const SCREENSHOT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MAX_SCREENSHOT_TOTAL_BYTES = 25 * 1024 * 1024;

app.get("/", async () => {
  return {
    ok: true,
    name: "Simple Dinners API",
    version: "simple-dinners-api-importer-v1",
  };
});

// =====================================================
// POST /interpret-smart-week-request
// Convert an optional natural-language request into
// validated planning guidance. This endpoint does not
// select recipes or create the weekly plan.
// =====================================================

app.post("/interpret-smart-week-request", async (request, reply) => {
  const requestText = String(
    request.body?.requestText || "",
  ).trim();

  const language =
    request.body?.language === "es"
      ? "es"
      : "en";

  if (!requestText) {
    return reply.code(400).send({
      success: false,
      error: "Smart Week request text is required.",
    });
  }

  if (requestText.length > 500) {
    return reply.code(400).send({
      success: false,
      error:
        "Smart Week requests must be 500 characters or fewer.",
    });
  }

  if (!openai) {
    return reply.code(503).send({
      success: false,
      successLevel: "ai-unavailable",
      error:
        "Smart Week request interpretation is temporarily unavailable.",
    });
  }

  try {
    const constraints =
      await interpretSmartWeekRequestWithAI(
        requestText,
        language,
      );

    return reply.send({
      success: true,
      debugVersion:
        "simple-dinners-api-smart-week-request-v1",
      aiAssisted: true,
      premiumFeatureKey: "smart_week",
      premiumEnforced: false,
      requestText,
      language,
      constraints,
    });
  } catch (error) {
    request.log.error(error);

    return reply.code(500).send({
      success: false,
      successLevel: "interpretation-error",
      error:
        error instanceof Error
          ? error.message
          : "Smart Week request interpretation failed.",
    });
  }
});

// =====================================================
// POST /resolve-pinterest
// Resolve a Pinterest pin to the original recipe website
// =====================================================

app.post("/resolve-pinterest", async (request, reply) => {
  const { url } = request.body || {};

  if (!url || typeof url !== "string") {
    return reply.code(400).send({
      ok: false,
      error: "Missing Pinterest URL.",
    });
  }

  const result = await resolvePinterestRecipeUrl(url);

  if (!result.ok) {
    return reply.code(422).send(result);
  }

  return reply.send(result);
});

// =====================================================
// POST /import-recipe
// Main recipe import endpoint
// =====================================================

app.post("/import-recipe", async (request, reply) => {
  const { url, captionText, sharedText } = request.body || {};

  const userCaptionText =
    typeof captionText === "string" && captionText.trim()
      ? captionText.trim()
      : typeof sharedText === "string" && sharedText.trim()
        ? sharedText.trim()
        : "";

  if (!url) {
    return reply.code(400).send({ error: "URL required" });
  }

  let importUrl = normalizeImportUrl(url);

  if (!importUrl || typeof importUrl !== "string") {
    return reply.code(400).send({
      success: false,
      successLevel: "bad-url",
      error: "Could not read a valid recipe URL from that shared link.",
      originalUrl: url,
      normalizedUrl: importUrl,
    });
  }

  let resolvedFromPinterest = false;
  let pinterestInputUrl = null;

  if (isPinterestRecipeCandidate(importUrl)) {
    console.log("Pinterest URL detected. Resolving original recipe URL...", {
      originalUrl: url,
      importUrl,
    });

    const pinterestResult = await resolvePinterestRecipeUrl(importUrl);

    if (!pinterestResult.ok) {
      return reply.code(422).send({
        error: pinterestResult.error,
        source: "pinterest",
        inputUrl: url,
        finalPinterestUrl: pinterestResult.finalPinterestUrl,
      });
    }

    pinterestInputUrl = importUrl;
    importUrl = pinterestResult.resolvedUrl;
    resolvedFromPinterest = true;

    console.log("Pinterest URL resolved:", {
      pinterestInputUrl,
      resolvedUrl: importUrl,
      title: pinterestResult.title,
    });
  }

  const startedAt = Date.now();

  console.log("Using Simple Dinners API importer:", {
    originalUrl: url,
    importUrl,
    resolvedFromPinterest,
    pinterestInputUrl,
  });

  let browser;
  let context;

  // -----------------------------------------------------
  // Playwright fallback setup
  // Only launches if fast HTML extraction is weak/blocked.
  // -----------------------------------------------------

  async function ensureBrowserContext() {
    if (context) return context;

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1365, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    return context;
  }

  async function runPlaywrightExtraction(targetUrl) {
    const activeContext = await ensureBrowserContext();
    const page = await activeContext.newPage();

    try {
      await page.route("**/*", (route) => {
        const resourceType = route.request().resourceType();

        if (["image", "font", "media"].includes(resourceType)) {
          return route.abort();
        }

        return route.continue();
      });

      return await loadAndExtractRecipe(page, targetUrl);
    } finally {
      try {
        await page.close();
      } catch {
        // Ignore page close errors.
      }
    }
  }

  try {
    // -----------------------------------------------------
    // Pass 1: Fast raw HTML extraction
    // This avoids Playwright entirely when JSON-LD recipe data is already in the page.
    // -----------------------------------------------------

    let firstResult = null;

    try {
      firstResult = await fetchAndExtractRecipe(importUrl);

      console.log("Fast HTML extraction finished:", {
        success: firstResult?.success,
        successLevel: firstResult?.successLevel,
        name: firstResult?.name,
        ingredientsCount: firstResult?.ingredients?.length || 0,
        instructionsCount: firstResult?.instructions?.length || 0,
      });
    } catch (fetchError) {
      console.log("Fast HTML extraction failed:", {
        error:
          fetchError instanceof Error
            ? fetchError.message
            : "Unknown fetch error",
      });
    }

    // -----------------------------------------------------
    // Pass 2: Playwright fallback
    // Used only when fast extraction fails, is blocked, or returns weak metadata.
    // -----------------------------------------------------

    if (!shouldUseFastImportResult(firstResult)) {
      firstResult = await runPlaywrightExtraction(importUrl);
    }

    if (!firstResult) {
      throw new Error("Recipe import did not return a result");
    }

    console.log("Recipe page extraction finished:", {
      seconds: Math.round((Date.now() - startedAt) / 1000),
      successLevel: firstResult?.successLevel,
      name: firstResult?.name,
      ingredientsCount: firstResult?.ingredients?.length || 0,
      instructionsCount: firstResult?.instructions?.length || 0,
    });

    firstResult = attachUserCaptionTextToResult(firstResult, userCaptionText);
    firstResult = await rescueSocialCaptionIfUseful(firstResult);
    firstResult = cleanSocialFallbackTitleIfNeeded(firstResult);

    console.log("Recipe result after caption rescue check:", {
      successLevel: firstResult?.successLevel,
      name: firstResult?.name,
      ingredientsCount: firstResult?.ingredients?.length || 0,
      instructionsCount: firstResult?.instructions?.length || 0,
      socialCaptionRescue: firstResult?.debug?.socialCaptionRescue === true,
      socialFallbackTitleCleaned:
        firstResult?.debug?.socialFallbackTitleCleaned === true,
    });

    // -----------------------------------------------------
    // Linked recipe follow-up
    // Example: Allrecipes article pages that link to the real recipe page.
    // -----------------------------------------------------

    const shouldFollowLinkedRecipe =
      firstResult.success &&
      firstResult.linkedRecipeUrl &&
      (firstResult.ingredients || []).length === 0;

    if (shouldFollowLinkedRecipe) {
      let linkedResult = null;

      try {
        linkedResult = await fetchAndExtractRecipe(firstResult.linkedRecipeUrl);

        console.log("Linked fast HTML extraction finished:", {
          success: linkedResult?.success,
          successLevel: linkedResult?.successLevel,
          name: linkedResult?.name,
          ingredientsCount: linkedResult?.ingredients?.length || 0,
          instructionsCount: linkedResult?.instructions?.length || 0,
        });
      } catch (fetchError) {
        console.log("Linked fast HTML extraction failed:", {
          error:
            fetchError instanceof Error
              ? fetchError.message
              : "Unknown fetch error",
        });
      }

      if (!shouldUseFastImportResult(linkedResult)) {
        linkedResult = await runPlaywrightExtraction(firstResult.linkedRecipeUrl);
      }

      const finalResult = {
        ...linkedResult,
        sourceUrl: url,
        importedFromUrl: firstResult.linkedRecipeUrl,
        recipe: linkedResult?.recipe
          ? {
            ...linkedResult.recipe,
            sourceUrl: firstResult.linkedRecipeUrl,
          }
          : null,
        debug: {
          ...(linkedResult?.debug || {}),
          followedLinkedRecipe: true,
          originalUrl: url,
          firstPageName: firstResult.name,
        },
      };

      return await applyAiCleanupToResult(finalResult);
    }

    return await applyAiCleanupToResult(firstResult);
  } catch (error) {
    request.log.error(error);

    return reply.code(500).send({
      success: false,
      successLevel: "error",
      error: error instanceof Error ? error.message : "Import failed",
    });
  } finally {
    if (browser) await browser.close();
  }
});


// =====================================================
// POST /import-jsonld
// Device-assisted import endpoint
// Receives JSON-LD extracted by the user's device/WebView
// =====================================================

app.post("/import-jsonld", async (request, reply) => {
  const { url, jsonLd } = request.body || {};

  if (!url) {
    return reply.code(400).send({ error: "URL required" });
  }

  if (!jsonLd || !String(jsonLd).trim()) {
    return reply.code(400).send({ error: "JSON-LD required" });
  }

  try {
    const importUrl = normalizeImportUrl(url);
    const result = extractRecipeFromJsonLd(String(jsonLd), importUrl);

    console.log("Device JSON-LD import finished:", {
      success: result?.success,
      successLevel: result?.successLevel,
      name: result?.name,
      ingredientsCount: result?.ingredients?.length || 0,
      instructionsCount: result?.instructions?.length || 0,
      sourceUrl: importUrl,
    });

    return await applyAiCleanupToResult(result);
  } catch (error) {
    request.log.error(error);

    return reply.code(500).send({
      success: false,
      successLevel: "error",
      error: error instanceof Error ? error.message : "JSON-LD import failed",
    });
  }
});

// =====================================================
// POST /import-screenshots
// Receive and validate screenshot uploads.
// AI vision processing will be added after upload plumbing is verified.
// =====================================================

app.post("/import-screenshots", async (request, reply) => {
  if (!request.isMultipart()) {
    return reply.code(415).send({
      success: false,
      successLevel: "invalid-content-type",
      error: "Screenshot uploads must use multipart/form-data.",
    });
  }

  const screenshots = [];
  const fields = {};
  let rejectedFile = null;

  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        const isScreenshotField =
          part.fieldname === "screenshot" ||
          part.fieldname === "screenshots";

        if (!isScreenshotField) {
          part.file.resume();
          continue;
        }

        if (!SCREENSHOT_MIME_TYPES.has(part.mimetype)) {
          rejectedFile = {
            filename: part.filename || "image",
            mimetype: part.mimetype || "unknown",
          };

          part.file.resume();
          continue;
        }

        const buffer = await part.toBuffer();

        if (buffer.length === 0) {
          continue;
        }

        screenshots.push({
          filename:
            part.filename || `screenshot-${screenshots.length + 1}`,
          mimetype: part.mimetype,
          size: buffer.length,
          buffer,
        });

        continue;
      }

      fields[part.fieldname] = String(part.value ?? "").trim();
    }

    if (rejectedFile) {
      return reply.code(415).send({
        success: false,
        successLevel: "unsupported-image-type",
        error: "Please upload JPEG, PNG, or WebP screenshots.",
        rejectedFile,
      });
    }

    if (screenshots.length === 0) {
      return reply.code(400).send({
        success: false,
        successLevel: "no-screenshots",
        error: "Please choose at least one screenshot.",
      });
    }

    const totalBytes = screenshots.reduce(
      (total, screenshot) => total + screenshot.size,
      0
    );

    if (totalBytes > MAX_SCREENSHOT_TOTAL_BYTES) {
      return reply.code(413).send({
        success: false,
        successLevel: "screenshots-too-large",
        error: "The selected screenshots are too large. Please use fewer or smaller images.",
        totalBytes,
        maximumBytes: MAX_SCREENSHOT_TOTAL_BYTES,
      });
    }

    console.log("Screenshot upload received:", {
      screenshotCount: screenshots.length,
      totalBytes,
      sourceUrl: fields.sourceUrl || "",
      language: fields.language || "en",
    });

    const visionResult = await extractRecipeTextFromScreenshots(screenshots, {
      sourceUrl: fields.sourceUrl || "",
      sourceTitle: fields.sourceTitle || "",
      language: fields.language || "en",
    });

    if (!visionResult.hasRecipeContent || !visionResult.extractedText) {
      return reply.code(422).send({
        success: false,
        successLevel: "no-recipe-found",
        debugVersion: "simple-dinners-api-screenshot-vision-v1",
        importMethod: "ai-screenshot",
        aiAssisted: true,
        premiumFeatureKey: "ai_screenshot_import",
        premiumEnforced: false,
        sourceUrl: fields.sourceUrl || "",
        sourceTitle: fields.sourceTitle || "",
        language: fields.language || "en",
        screenshotCount: screenshots.length,
        totalBytes,
        extractedTitle: visionResult.title,
        extractedServings: visionResult.servings,
        extractedText: visionResult.extractedText,
        possibleMissingBeginning: visionResult.possibleMissingBeginning,
        possibleMissingEnding: visionResult.possibleMissingEnding,
        warnings: visionResult.warnings,
        error: "We could not find enough visible recipe content in those screenshots.",
      });
    }

    const parsed = await parseRecipeTextWithAI(visionResult.extractedText);

    const parsedIngredients = Array.isArray(parsed.ingredients)
      ? parsed.ingredients
        .map(cleanHtmlEntities)
        .map(cleanText)
        .filter(Boolean)
      : [];

    const parsedInstructions = Array.isArray(parsed.instructions)
      ? parsed.instructions
        .map(cleanHtmlEntities)
        .map(cleanText)
        .filter(Boolean)
      : [];

    const genericParsedTitles = new Set([
      "",
      "imported recipe",
      "saved recipe",
      "screenshot recipe",
      "recipe",
    ]);

    const parsedTitle = cleanText(parsed.name || "");

    let recipeName = cleanText(
      visionResult.title ||
      fields.sourceTitle ||
      (!genericParsedTitles.has(parsedTitle.toLowerCase())
        ? parsedTitle
        : "") ||
      "Screenshot Recipe"
    );

    const titleSource = visionResult.title
      ? "visible-in-screenshot"
      : fields.sourceTitle
        ? "source-metadata"
        : !genericParsedTitles.has(parsedTitle.toLowerCase())
          ? "ai-inferred-from-visible-text"
          : "fallback";

    const hasIngredients = parsedIngredients.length > 0;
    const hasInstructions = parsedInstructions.length > 0;

    const coreRecipeAppearsComplete =
      visionResult.ingredientsAppearComplete &&
      visionResult.instructionsAppearComplete;

    const screenshotAppearsIncomplete =
      visionResult.possibleMissingBeginning ||
      visionResult.possibleMissingEnding;

    const successLevel =
      hasIngredients && hasInstructions && coreRecipeAppearsComplete
        ? "full"
        : hasIngredients || hasInstructions
          ? "partial"
          : "metadata-only";

    const sourceUrl = fields.sourceUrl || "";

    const roughRecipe = {
      name: recipeName,
      ingredients: parsedIngredients.join("\n"),
      instructions: hasInstructions
        ? parsedInstructions.join("\n")
        : SOURCE_STEPS_PLACEHOLDER,
      servings: visionResult.servings || "",
      photoUrl: "",
      slug: `${slugify(recipeName)}-${Date.now().toString().slice(-4)}`,
      sourceUrl,
      effort: "normal",
      importStatus: successLevel,
      fallbackText:
        successLevel === "full" ? "" : visionResult.extractedText,
    };

    const result = {
      success: true,
      successLevel,
      debugVersion: "simple-dinners-api-screenshot-import-v1",

      sourceUrl,
      importedFromUrl: sourceUrl,

      name: recipeName,
      ingredients: parsedIngredients,
      instructions: parsedInstructions,
      servings: visionResult.servings || "",
      image: "",
      linkedRecipeUrl: "",

      recipe: roughRecipe,

      importMethod: "ai-screenshot",
      aiAssisted: true,
      needsReview: true,
      canSaveNeedsFinishing: successLevel !== "full",

      premiumFeatureKey: "ai_screenshot_import",
      premiumEnforced: false,

      screenshotImport: {
        screenshotCount: screenshots.length,
        totalBytes,
        titleSource,
        visibleTitle: visionResult.title,
        visibleServings: visionResult.servings,
        possibleMissingBeginning: visionResult.possibleMissingBeginning,
        possibleMissingEnding: visionResult.possibleMissingEnding,
        warnings: visionResult.warnings,
        ingredientsAppearComplete:
          visionResult.ingredientsAppearComplete,

        instructionsAppearComplete:
          visionResult.instructionsAppearComplete,

        coreRecipeAppearsComplete,
      },

      aiInference: {
        titleWasInferred: titleSource === "ai-inferred-from-visible-text",
        recipeContentOrganizedByAI: true,
        missingContentCompletedByAI: false,
        note:
          "Ingredients and instructions were organized from text visible in the screenshots. Missing recipe content was not intentionally completed.",
      },

      extractedText: visionResult.extractedText,

      debug: {
        screenshotImport: true,
        screenshotCount: screenshots.length,
        totalBytes,
        titleSource,
        parserIngredientsCount: parsedIngredients.length,
        parserInstructionsCount: parsedInstructions.length,
        screenshotAppearsIncomplete,
        coreRecipeAppearsComplete,
      },
    };

    console.log("Screenshot recipe parsing finished:", {
      successLevel,
      name: recipeName,
      titleSource,
      ingredientsCount: parsedIngredients.length,
      instructionsCount: parsedInstructions.length,
      screenshotAppearsIncomplete,
    });

    return reply.send(result);
  } catch (error) {
    request.log.error(error);

    const statusCode = Number(error?.statusCode) || 500;
    const errorCode = String(error?.code || "");

    const uploadLimitReached =
      statusCode === 413 ||
      errorCode.includes("LIMIT") ||
      errorCode.includes("TOO_LARGE");

    return reply.code(uploadLimitReached ? 413 : 500).send({
      success: false,
      successLevel: uploadLimitReached
        ? "upload-limit-reached"
        : "upload-error",
      error: uploadLimitReached
        ? "Too many screenshots or one of the files is too large."
        : error instanceof Error
          ? error.message
          : "Screenshot upload failed.",
    });
  }
});

// =====================================================
// POST /import-text
// Paste raw recipe text and normalize into recipe format
// =====================================================

app.post("/import-text", async (request, reply) => {
  const { text } = request.body || {};

  if (!text || !String(text).trim()) {
    return reply.code(400).send({ error: "Recipe text required" });
  }

  try {
    const parsed = await parseRecipeTextWithAI(String(text));

    const recipeName = cleanText(parsed.name || "Imported Recipe");

    const roughRecipe = {
      name: recipeName,
      ingredients: Array.isArray(parsed.ingredients)
        ? parsed.ingredients.join("\n")
        : "",
      instructions: Array.isArray(parsed.instructions)
        ? parsed.instructions.join("\n")
        : "",
      photoUrl: "",
      slug: `${slugify(recipeName)}-${Date.now().toString().slice(-4)}`,
      sourceUrl: "",
      effort: "normal",
      importStatus: "text-import",
      fallbackText: "",
    };

    const result = {
      success: true,
      successLevel: "full",
      debugVersion: "simple-dinners-api-text-import-v1",
      sourceUrl: "",
      importedFromUrl: "",
      name: recipeName,
      ingredients: roughRecipe.ingredients.split("\n").filter(Boolean),
      instructions: roughRecipe.instructions.split("\n").filter(Boolean),
      image: "",
      linkedRecipeUrl: "",
      recipe: roughRecipe,
      debug: {
        textImport: true,
        originalTextLength: String(text).length,
      },
    };

    return await applyAiCleanupToResult(result);
  } catch (error) {
    request.log.error(error);

    return reply.code(500).send({
      success: false,
      successLevel: "error",
      error: error instanceof Error ? error.message : "Text import failed",
    });
  }
});

// =====================================================
// Page loading + extraction pipeline
// Fast HTML first, Playwright fallback second
// =====================================================

function extractJsonLdBlocksFromHtml(html) {
  const $ = cheerio.load(html);
  const blocks = [];

  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).text().trim();

    if (raw) {
      blocks.push(raw);
    }
  });

  return blocks;
}

async function fetchAndExtractRecipe(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  if (!response.ok) {
    return {
      success: false,
      successLevel: "fetch-failed",
      error: `Fetch failed with status ${response.status}`,
      status: response.status,
    };
  }

  const html = await response.text();
  const finalUrl = response.url || url;

  const jsonLdBlocks = extractJsonLdBlocksFromHtml(html);

  for (const block of jsonLdBlocks) {
    const jsonLdResult = extractRecipeFromJsonLd(block, finalUrl);

    if (
      jsonLdResult?.success &&
      jsonLdResult.successLevel !== "metadata-only"
    ) {
      return jsonLdResult;
    }
  }

  const $ = cheerio.load(html);

  return extractRecipeFromPage($, url, finalUrl);
}

function shouldUseFastImportResult(result) {
  return (
    result?.success &&
    result?.recipe &&
    result.successLevel !== "metadata-only" &&
    result.successLevel !== "social-metadata-only" &&
    result.successLevel !== "blocked" &&
    result.successLevel !== "fetch-failed"
  );
}

async function loadAndExtractRecipe(page, url) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  try {
    await page.waitForLoadState("load", { timeout: 5000 });
  } catch {
    // Some ad-heavy sites never fully load. That's okay.
  }

  await page.waitForTimeout(1500);

  const html = await page.content();
  const finalUrl = page.url();

  const jsonLdBlocks = extractJsonLdBlocksFromHtml(html);

  for (const block of jsonLdBlocks) {
    const jsonLdResult = extractRecipeFromJsonLd(block, finalUrl);

    if (
      jsonLdResult?.success &&
      jsonLdResult.successLevel !== "metadata-only"
    ) {
      return jsonLdResult;
    }
  }

  const $ = cheerio.load(html);

  return extractRecipeFromPage($, url, finalUrl);
}

// =====================================================
// URL cleanup helpers
// Handles shared links, redirects, tracking params, and social URLs
// =====================================================

function normalizeImportUrl(rawUrl) {
  const value = String(rawUrl || "").trim();

  if (!value) return "";

  const firstUrlMatch = value.match(/https?:\/\/[^\s"'<>]+/i);
  const candidate = firstUrlMatch ? firstUrlMatch[0] : value;

  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();

    const redirectParamNames = [
      "u",
      "url",
      "target",
      "redirect",
      "redirect_url",
      "next",
    ];

    for (const paramName of redirectParamNames) {
      const possibleRedirect = parsed.searchParams.get(paramName);

      if (!possibleRedirect) continue;

      try {
        const redirectUrl = new URL(possibleRedirect, parsed.origin).toString();

        if (redirectUrl && /^https?:\/\//i.test(redirectUrl)) {
          return normalizeImportUrl(redirectUrl);
        }
      } catch {
        // Ignore invalid redirect values.
      }
    }

    // Instagram sometimes shares login-wrapper URLs like:
    // /accounts/login/?next=https%3A%2F%2Fwww.instagram.com%2Freel%2F...
    // Unwrap those before treating the URL as a valid social recipe source.
    if (
      host.includes("instagram.com") &&
      parsed.pathname.includes("/accounts/login")
    ) {
      const nextUrl = parsed.searchParams.get("next");

      if (nextUrl) {
        try {
          const normalizedNextUrl = new URL(nextUrl, parsed.origin).toString();

          if (normalizedNextUrl) {
            return normalizeImportUrl(normalizedNextUrl);
          }
        } catch {
          // Fall through safely.
        }
      }
    }

    if (
      host.includes("facebook.com") ||
      host.includes("fb.watch") ||
      host.includes("instagram.com") ||
      host.includes("tiktok.com") ||
      host.includes("pinterest.com") ||
      host.includes("pin.it")
    ) {
      return parsed.toString();
    }

    parsed.hash = "";

    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
    ].forEach((key) => parsed.searchParams.delete(key));

    return parsed.toString();
  } catch {
    return candidate || "";
  }
}
function isSocialRecipeUrl(url) {
  const value = String(url || "").toLowerCase();

  return (
    value.includes("facebook.com") ||
    value.includes("fb.watch") ||
    value.includes("instagram.com") ||
    value.includes("tiktok.com") ||
    value.includes("pinterest.com")
  );
}

function cleanSocialRecipeTitle(name, fallbackText = "", sourceUrl = "") {
  return chooseSocialRecipeTitle({
    rawName: name,
    fallbackText,
    sourceUrl,
  });
}
function extractRecipeFromJsonLd(jsonLdText, sourceUrl) {
  const rawText = String(jsonLdText || "").trim();

  const normalizedText = rawText
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");

  let recipe = null;

  try {
    const parsed = JSON.parse(normalizedText);
    recipe = findRecipe(parsed);
  } catch {
    // Fall back to direct object extraction below.
  }

  function extractRecipeObjectText(text) {
    const recipeIndex = text.indexOf('"@type":"Recipe"');
    if (recipeIndex < 0) return "";

    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = recipeIndex; i >= 0; i--) {
      if (text[i] === "{") {
        start = i;
        break;
      }
    }

    if (start < 0) return "";

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === "{") depth++;
      if (char === "}") depth--;

      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }

    return "";
  }

  if (!recipe) {
    const recipeObjectText = extractRecipeObjectText(normalizedText);

    try {
      if (recipeObjectText) {
        const safeRecipeObjectText = recipeObjectText
          .replace(/[\u0000-\u001F]+/g, " ")
          .replace(/\\([^"\\/bfnrtu])/g, "$1");

        recipe = JSON.parse(safeRecipeObjectText);
      }
    } catch {
      recipe = null;
    }
  }

  const recipeName = cleanHtmlEntities(
    cleanText(recipe?.name || recipe?.headline || "Imported Recipe")
  );

  const ingredients = Array.isArray(recipe?.recipeIngredient)
    ? recipe.recipeIngredient
      .map(cleanHtmlEntities)
      .map(cleanText)
      .filter(Boolean)
    : [];

  const instructions = extractInstructions(recipe?.recipeInstructions)
    .map(cleanHtmlEntities)
    .map(cleanText)
    .filter(Boolean);

  const image = extractImage(recipe?.image);

  const hasIngredients = ingredients.length > 0;
  const hasInstructions = instructions.length > 0;

  const successLevel =
    hasIngredients && hasInstructions
      ? "full"
      : hasIngredients || hasInstructions
        ? "partial"
        : "metadata-only";

  return {
    success: true,
    successLevel,
    debugVersion: "simple-dinners-api-jsonld-import-v7",
    sourceUrl,
    importedFromUrl: sourceUrl,
    name: recipeName,
    ingredients,
    instructions,
    image,
    linkedRecipeUrl: "",
    recipe: {
      name: recipeName,
      ingredients: hasIngredients ? ingredients.join("\n") : "",
      instructions: hasInstructions
        ? instructions.join("\n")
        : SOURCE_STEPS_PLACEHOLDER,
      photoUrl: image,
      slug: `${slugify(recipeName)}-${Date.now().toString().slice(-4)}`,
      sourceUrl,
      effort: "normal",
      importStatus: successLevel,
      fallbackText: !hasIngredients && !hasInstructions
        ? [recipeName, sourceUrl].filter(Boolean).join("\n\n")
        : "",
    },
    debug: {
      jsonLdImport: true,
      foundRecipe: !!recipe,
      ingredientsCount: ingredients.length,
      instructionsCount: instructions.length,
      finalUrl: sourceUrl,
    },
  };
}

function extractRecipeFromPage($, sourceUrl, finalUrl) {
  if (isBlockedPage($, finalUrl)) {
    const pageTitle = cleanHtmlEntities(cleanText($("title").text()));

    return {
      success: false,
      successLevel: "blocked",
      debugVersion: "simple-dinners-api-importer-v1",
      sourceUrl,
      importedFromUrl: finalUrl,
      name: "",
      ingredients: [],
      instructions: [],
      image: "",
      linkedRecipeUrl: "",
      recipe: null,
      error:
        "This site blocked the recipe importer. Try another link or add the recipe manually.",
      debug: {
        blocked: true,
        finalUrl,
        pageTitle,
      },
    };
  }

  let recipe = null;

  $("script[type='application/ld+json']").each((_, el) => {
    if (recipe) return;

    try {
      const raw = $(el).text();
      const parsed = JSON.parse(raw);
      const found = findRecipe(parsed);

      if (found) recipe = found;
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
  });

  const rawName =
    recipe?.name ||
    recipe?.headline ||
    $("meta[property='og:title']").attr("content") ||
    $("title").text() ||
    "Imported Recipe";

  let recipeName = cleanHtmlEntities(cleanText(rawName));

  let ingredients = Array.isArray(recipe?.recipeIngredient)
    ? recipe.recipeIngredient.map(cleanHtmlEntities).map(cleanText).filter(Boolean)
    : [];

  let instructions = extractInstructions(recipe?.recipeInstructions)
    .map(cleanHtmlEntities)
    .map(cleanText)
    .filter(Boolean);

  if (ingredients.length === 0) {
    if (finalUrl.includes("natashaskitchen.com")) {
      ingredients = extractNatashaIngredients($);
    }

    if (ingredients.length === 0) {
      ingredients = extractBySelectors($, [
        "[data-ingredient-name='true']",
        ".mntl-structured-ingredients__list-item",
        ".ingredients-item-name",
        "li[class*='ingredient']",
      ]);
    }
  }

  if (instructions.length === 0) {
    if (finalUrl.includes("natashaskitchen.com")) {
      instructions = extractNatashaInstructions($);
    }

    if (instructions.length === 0) {
      instructions = extractBySelectors($, [
        ".comp.mntl-sc-block.mntl-sc-block-html",
        ".mntl-sc-block-group--LI",
        "li[class*='instruction']",
        "p[class*='instruction']",
        "div[class*='direction']",
      ])
        .filter((line) =>
          /mix|stir|cook|bake|heat|place|add|whisk|combine|pour|season|serve|remove|transfer|drain|spread|sprinkle|preheat/i.test(
            line
          )
        )
        .filter(
          (step) =>
            !/watch|video|subscribe|newsletter|follow|instagram|youtube/i.test(
              step
            )
        )
        .filter(
          (step) =>
            !/^pro tip:/i.test(step) &&
            !/^this soup freezes/i.test(step) &&
            !/^this will yield/i.test(step) &&
            !/^refer to package/i.test(step)
        );
    }
  }

  ingredients = ingredients.map(cleanHtmlEntities).map(cleanText).filter(Boolean);
  instructions = instructions.map(cleanHtmlEntities).map(cleanText).filter(Boolean);

  const image =
    extractImage(recipe?.image) ||
    $("meta[property='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content") ||
    "";

  const description = cleanHtmlEntities(
    cleanText(
      $("meta[property='og:description']").attr("content") ||
      $("meta[name='description']").attr("content") ||
      $("meta[name='twitter:description']").attr("content") ||
      ""
    )
  );

  const isSocialSource = isSocialRecipeUrl(finalUrl) || isSocialRecipeUrl(sourceUrl);
  const originalRecipeName = recipeName;
  const socialCaptionParts = isSocialSource
    ? resolveSocialCaptionParts({
      rawName: originalRecipeName,
      description,
      sourceUrl: finalUrl,
    })
    : null;

  const linkedRecipeUrl = finalUrl.includes("allrecipes.com")
    ? findAllrecipesRecipeLink($, finalUrl, recipeName)
    : "";

  const hasIngredients = ingredients.length > 0;
  const hasInstructions = instructions.length > 0;

  const successLevel =
    hasIngredients && hasInstructions
      ? "full"
      : hasIngredients || hasInstructions
        ? "partial"
        : isSocialSource
          ? "social-metadata-only"
          : "metadata-only";

  return {
    success: true,
    successLevel,
    debugVersion: "simple-dinners-api-importer-v1",
    sourceUrl,
    importedFromUrl: finalUrl,
    name: recipeName,
    ingredients,
    instructions,
    image,
    linkedRecipeUrl,
    recipe: {
      name: recipeName,
      ingredients: hasIngredients ? ingredients.join("\n") : "",
      instructions: hasInstructions
        ? instructions.join("\n")
        : SOURCE_STEPS_PLACEHOLDER,
      photoUrl: image,
      slug: `${slugify(recipeName)}-${Date.now().toString().slice(-4)}`,
      sourceUrl: finalUrl,
      effort: "normal",
      importStatus: successLevel,
      fallbackText: !hasIngredients && !hasInstructions
        ? [recipeName, description, finalUrl].filter(Boolean).join("\n\n")
        : "",
    },
    debug: {
      foundRecipe: !!recipe,
      ingredientsCount: ingredients.length,
      instructionsCount: instructions.length,
      finalUrl,
      linkedRecipeUrl,
      description,
      isSocialSource,
      originalRecipeName: isSocialSource ? originalRecipeName : undefined,
      socialCaptionParts: socialCaptionParts
        ? {
          platform: socialCaptionParts.platform,
          accountName: socialCaptionParts.accountName,
          rawCaption: socialCaptionParts.rawCaption,
          titleCandidate: socialCaptionParts.titleCandidate,
          fallbackTitle: socialCaptionParts.fallbackTitle,
        }
        : undefined,
    },
  };
}


function instructionsMentionEnoughIngredients(ingredientsText, instructionsText) {
  const ingredientWords = String(ingredientsText || "")
    .toLowerCase()
    .split("\n")
    .flatMap((line) =>
      line
        .replace(/\([^)]*\)/g, " ")
        .replace(/\d+\/\d+|\d+(\.\d+)?/g, " ")
        .replace(
          /\b(cup|cups|tbsp|tablespoons?|tsp|teaspoons?|lb|lbs|pound|pounds|oz|ounce|ounces|can|cans|jar|jars|package|packages|small|medium|large|fresh|dried|chopped|minced|sliced|diced|to|taste|for|with|and|the)\b/g,
          " "
        )
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
    )
    .map((word) => word.trim())
    .filter((word) => word.length > 3);

  const uniqueWords = Array.from(new Set(ingredientWords)).slice(0, 20);
  const instructions = String(instructionsText || "").toLowerCase();

  if (uniqueWords.length === 0) return false;

  const matchedCount = uniqueWords.filter((word) =>
    instructions.includes(word)
  ).length;

  return matchedCount >= Math.min(4, Math.ceil(uniqueWords.length * 0.35));
}

function attachUserCaptionTextToResult(result, captionText = "") {
  const cleanedCaption = String(captionText || "").trim();

  if (!cleanedCaption || !result?.success || !result?.recipe) {
    return result;
  }

  const existingFallbackText = String(result.recipe.fallbackText || "").trim();

  result.recipe.fallbackText = [cleanedCaption, existingFallbackText]
    .filter(Boolean)
    .join("\n\n");

  result.debug = {
    ...(result.debug || {}),
    userCaptionTextProvided: true,
    userCaptionTextLength: cleanedCaption.length,
    userCaptionText: cleanedCaption,
  };

  return result;
}

// =====================================================
// Social caption rescue
// Used when Instagram/social pages return caption text but no structured recipe
// =====================================================

function resultNeedsCaptionRescue(result) {
  if (!result?.success || !result?.recipe) return false;

  const hasIngredients =
    typeof result.recipe.ingredients === "string" &&
    result.recipe.ingredients.trim().length > 0;

  const hasInstructions =
    typeof result.recipe.instructions === "string" &&
    result.recipe.instructions.trim().length > 0 &&
    result.recipe.instructions !== SOURCE_STEPS_PLACEHOLDER;

  if (hasIngredients || hasInstructions) return false;

  return (
    result.successLevel === "metadata-only" ||
    result.successLevel === "social-metadata-only"
  );
}

function buildCaptionRescueText(result) {
  const userCaptionText =
    result.debug?.userCaptionTextProvided && result.debug?.userCaptionText
      ? String(result.debug.userCaptionText).trim()
      : "";

  // Caption Assist rule:
  // If the user pasted caption text, use that as the primary rescue source.
  // This prevents Instagram metadata from winning over the caption the user intentionally provided.
  if (userCaptionText) {
    const parts = [userCaptionText, result.sourceUrl]
      .filter(Boolean)
      .map((part) => String(part).trim())
      .filter(Boolean);

    return Array.from(new Set(parts)).join("\n\n");
  }

  const sourceUrl =
    result.sourceUrl || result.importedFromUrl || result.recipe?.sourceUrl || "";

  const socialCaptionParts = resolveSocialCaptionParts({
    rawName:
      result.debug?.originalRecipeName ||
      result.name ||
      result.recipe?.name ||
      "",
    description: result.debug?.description || "",
    fallbackText: result.recipe?.fallbackText || "",
    sourceUrl,
  });

  result.debug = {
    ...(result.debug || {}),
    socialCaptionPartsForRescue: {
      platform: socialCaptionParts.platform,
      accountName: socialCaptionParts.accountName,
      rawCaption: socialCaptionParts.rawCaption,
      titleCandidate: socialCaptionParts.titleCandidate,
      fallbackTitle: socialCaptionParts.fallbackTitle,
    },
  };

  return socialCaptionParts.rescueText;
}
function looksLikeRecipeCaption(text) {
  const raw = String(text || "");
  const value = raw.toLowerCase();

  if (value.length < 120) return false;

  const hasIngredientSignal =
    /ingredients?(?:\s*\([^)]*\))?\s*[:~\-]/i.test(raw) ||
    /what\s+you(?:'|’)?ll\s+need\s*[:~\-]?/i.test(raw) ||
    /what\s+you\s+need\s*[:~\-]?/i.test(raw);

  const hasInstructionSignal =
    /(instructions?|directions?|method|steps?|how\s+to\s+make)(?:\s*\([^)]*\))?\s*[:~\-]/i.test(
      raw
    ) ||
    /\b1\s*[-.)]/.test(raw) ||
    /1️⃣|2️⃣|3️⃣|4️⃣|5️⃣/.test(raw);

  const hasCookingWords =
    /\b(mix|stir|cook|bake|heat|add|combine|whisk|serve|marinate|drizzle|garnish|assemble|season|simmer|boil|grill|fry|sauté|saute|toss)\b/i.test(
      raw
    );

  return hasIngredientSignal && (hasInstructionSignal || hasCookingWords);
}

function parseCaptionAssistTextWithoutAI(text) {
  const normalizedText = String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = normalizedText
    .split(/\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  if (lines.length === 0) {
    return { name: "", ingredients: [], instructions: [] };
  }

  const ingredientHeaderIndex = lines.findIndex((line) =>
    /^ingredients?(?:\s*\([^)]*\))?\s*[:~\-]?$/i.test(line)
  );

  const instructionHeaderIndex = lines.findIndex((line) =>
    /^(instructions?|directions?|method|steps?|how\s+to\s+make)(?:\s*\([^)]*\))?\s*[:~\-]?$/i.test(
      line
    )
  );

  if (
    ingredientHeaderIndex < 0 ||
    instructionHeaderIndex < 0 ||
    instructionHeaderIndex <= ingredientHeaderIndex
  ) {
    return { name: "", ingredients: [], instructions: [] };
  }

  const name =
    lines
      .slice(0, ingredientHeaderIndex)
      .find((line) => line.length > 2 && !/^https?:\/\//i.test(line)) ||
    "Imported Recipe";

  const stopLine =
    /^(tips?|notes?|hashtags?|save|follow|like|comment|share|for\s+more)\s*[:~\-]?$/i;

  const ingredients = lines
    .slice(ingredientHeaderIndex + 1, instructionHeaderIndex)
    .filter((line) => !stopLine.test(line))
    .filter((line) => !/^#|^@/.test(line))
    .filter(Boolean);

  const rawInstructionLines = lines.slice(instructionHeaderIndex + 1);
  const instructions = [];

  for (const line of rawInstructionLines) {
    if (stopLine.test(line)) break;
    if (/^#|^@/.test(line)) break;

    const cleaned = line
      .replace(/^\d+\s*[\).:-]\s*/g, "")
      .replace(/^[1-9]️⃣\s*/g, "")
      .trim();

    if (cleaned) {
      instructions.push(cleaned);
    }
  }

  return {
    name,
    ingredients,
    instructions,
  };
}

async function rescueSocialCaptionIfUseful(result) {
  const userCaptionTextProvided =
    result.debug?.userCaptionTextProvided === true;

  const needsRescue = resultNeedsCaptionRescue(result);

  result.debug = {
    ...(result.debug || {}),
    captionAssistRescueChecked: true,
    captionAssistNeedsRescue: needsRescue,
    captionAssistUserCaptionTextProvided: userCaptionTextProvided,
  };

  if (!needsRescue) {
    result.debug.captionAssistExitReason = "result-does-not-need-rescue";
    return result;
  }

  const rescueText = buildCaptionRescueText(result);
  const looksLikeCaptionRecipe = looksLikeRecipeCaption(rescueText);

  result.debug = {
    ...(result.debug || {}),
    captionAssistRescueBypassActive: userCaptionTextProvided,
    captionAssistRescueTextLength: rescueText.length,
    captionAssistLooksLikeRecipeCaption: looksLikeCaptionRecipe,
  };

  if (!userCaptionTextProvided && !looksLikeCaptionRecipe) {
    result.debug.captionAssistExitReason = "scraped-caption-did-not-look-like-recipe";
    return result;
  }

  if (userCaptionTextProvided && rescueText.trim().length < 80) {
    result.debug.captionAssistExitReason = "pasted-caption-too-short";
    return result;
  }

  if (!openai) {
    console.log("Social caption rescue skipped: OPENAI_API_KEY is not set.");
    return result;
  }

  try {
    console.log("Trying social caption recipe rescue:", {
      name: result.name,
      sourceUrl: result.sourceUrl,
      textLength: rescueText.length,
    });

    const parsed = await parseRecipeTextWithAI(rescueText);

    const rescueSourceUrl =
      result.sourceUrl || result.importedFromUrl || result.recipe?.sourceUrl || "";

    const rescuedName = cleanSocialRecipeTitle(
      parsed.name || result.name || "Saved Recipe",
      rescueText,
      rescueSourceUrl
    );

    const rescuedIngredients = Array.isArray(parsed.ingredients)
      ? parsed.ingredients.map(cleanHtmlEntities).map(cleanText).filter(Boolean)
      : [];

    const rescuedInstructions = Array.isArray(parsed.instructions)
      ? parsed.instructions.map(cleanHtmlEntities).map(cleanText).filter(Boolean)
      : [];

    if (rescuedIngredients.length === 0 || rescuedInstructions.length === 0) {
      console.log("Social caption rescue did not find enough recipe details:", {
        ingredientsCount: rescuedIngredients.length,
        instructionsCount: rescuedInstructions.length,
      });

      return result;
    }

    const rescuedRecipe = {
      name: rescuedName,
      ingredients: rescuedIngredients.join("\n"),
      instructions: rescuedInstructions.join("\n"),
      photoUrl: result.image || result.recipe?.photoUrl || "",
      slug: `${slugify(rescuedName)}-${Date.now().toString().slice(-4)}`,
      sourceUrl: result.recipe?.sourceUrl || result.importedFromUrl || result.sourceUrl || "",
      effort: "normal",
      importStatus: "full",
      fallbackText: "",
    };

    return {
      ...result,
      success: true,
      successLevel: "full",
      debugVersion: "simple-dinners-api-social-caption-rescue-v1",
      name: rescuedName,
      ingredients: rescuedIngredients,
      instructions: rescuedInstructions,
      recipe: rescuedRecipe,
      debug: {
        ...(result.debug || {}),
        socialCaptionRescue: true,
        originalSuccessLevel: result.successLevel,
        originalName: result.name,
        rescueTextLength: rescueText.length,
        ingredientsCount: rescuedIngredients.length,
        instructionsCount: rescuedInstructions.length,
      },
      aiRescue: {
        enabled: true,
        type: "social-caption",
        note: "Recipe details were organized from visible social caption text.",
      },
    };
  } catch (error) {
    console.error("Social caption rescue failed:", error);

    const fallbackParsed = parseCaptionAssistTextWithoutAI(rescueText);

    if (
      userCaptionTextProvided &&
      fallbackParsed.ingredients.length > 0 &&
      fallbackParsed.instructions.length > 0
    ) {
      const fallbackName = cleanSocialRecipeTitle(
        fallbackParsed.name || result.name || "Saved Recipe",
        rescueText,
        result.sourceUrl || result.importedFromUrl || result.recipe?.sourceUrl || ""
      );

      const fallbackRecipe = {
        name: fallbackName,
        ingredients: fallbackParsed.ingredients.join("\n"),
        instructions: fallbackParsed.instructions.join("\n"),
        photoUrl: result.image || result.recipe?.photoUrl || "",
        slug: `${slugify(fallbackName)}-${Date.now().toString().slice(-4)}`,
        sourceUrl:
          result.recipe?.sourceUrl || result.importedFromUrl || result.sourceUrl || "",
        effort: "normal",
        importStatus: "full",
        fallbackText: "",
      };

      return {
        ...result,
        success: true,
        successLevel: "full",
        debugVersion: "simple-dinners-api-caption-assist-fallback-v1",
        name: fallbackName,
        ingredients: fallbackParsed.ingredients,
        instructions: fallbackParsed.instructions,
        recipe: fallbackRecipe,
        debug: {
          ...(result.debug || {}),
          socialCaptionRescue: true,
          captionAssistFallbackParserUsed: true,
          captionAssistExitReason: "ai-rescue-error-fallback-parser-used",
          captionAssistRescueError:
            error instanceof Error ? error.message : "Unknown caption rescue error",
          ingredientsCount: fallbackParsed.ingredients.length,
          instructionsCount: fallbackParsed.instructions.length,
        },
        aiRescue: {
          enabled: false,
          type: "caption-assist-fallback",
          note: "Recipe details were organized from pasted caption text without AI.",
        },
      };
    }

    result.debug = {
      ...(result.debug || {}),
      captionAssistExitReason: "ai-rescue-error",
      captionAssistRescueError:
        error instanceof Error ? error.message : "Unknown caption rescue error",
    };

    return result;
  }
}

function cleanSocialFallbackTitleIfNeeded(result) {
  if (!result?.success || !result?.recipe) return result;

  const sourceUrl =
    result.sourceUrl || result.importedFromUrl || result.recipe?.sourceUrl || "";

  const isSocialSource =
    isSocialRecipeUrl(sourceUrl) || result.debug?.isSocialSource === true;

  if (!isSocialSource) return result;

  // If AI rescue worked, keep the real rescued recipe title.
  if (result.debug?.socialCaptionRescue === true) {
    return result;
  }

  const hasIngredients =
    Array.isArray(result.ingredients) && result.ingredients.length > 0;

  const hasInstructions =
    Array.isArray(result.instructions) && result.instructions.length > 0;

  // If a social post somehow produced a full recipe without rescue, preserve it.
  if (hasIngredients && hasInstructions) {
    return result;
  }

  const originalName =
    result.debug?.originalRecipeName || result.name || result.recipe?.name || "";

  const userCaptionText =
    result.debug?.userCaptionTextProvided && result.debug?.userCaptionText
      ? String(result.debug.userCaptionText).trim()
      : "";

  const socialCaptionParts = resolveSocialCaptionParts({
    rawName: originalName,
    description: result.debug?.description || "",
    fallbackText: [userCaptionText, result.recipe?.fallbackText || ""]
      .filter(Boolean)
      .join("\n\n"),
    sourceUrl,
  });

  const cleanedName =
    socialCaptionParts.titleCandidate || socialCaptionParts.fallbackTitle;

  result.name = cleanedName;
  result.recipe.name = cleanedName;
  result.recipe.slug = `${slugify(cleanedName)}-${Date.now()
    .toString()
    .slice(-4)}`;

  // Keep the useful raw caption/source hidden in fallbackText for manual finishing.
  if (socialCaptionParts.rescueText) {
    result.recipe.fallbackText = socialCaptionParts.rescueText;
  }

  result.debug = {
    ...(result.debug || {}),
    socialFallbackTitleCleaned: true,
    originalSocialFallbackName: originalName,
    socialCaptionPartsForFallback: {
      platform: socialCaptionParts.platform,
      accountName: socialCaptionParts.accountName,
      rawCaption: socialCaptionParts.rawCaption,
      titleCandidate: socialCaptionParts.titleCandidate,
      fallbackTitle: socialCaptionParts.fallbackTitle,
    },
  };

  return result;
}

// =====================================================
// AI cleanup result wrapper
// Runs only after final import / linked recipe follow is complete
// =====================================================

async function applyAiCleanupToResult(result) {
  if (!result?.success || !result?.recipe) return result;

  const hasIngredients =
    typeof result.recipe.ingredients === "string" &&
    result.recipe.ingredients.trim().length > 0;

  const hasInstructions =
    typeof result.recipe.instructions === "string" &&
    result.recipe.instructions.trim().length > 0 &&
    result.recipe.instructions !== SOURCE_STEPS_PLACEHOLDER;

  if (!hasIngredients && !hasInstructions) return result;

  const ingredientCount = result.recipe.ingredients
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;

  const instructionCount = result.recipe.instructions
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;

  const instructionsAlreadyUseful = instructionsMentionEnoughIngredients(
    result.recipe.ingredients,
    result.recipe.instructions
  );

  // -----------------------------------------------------
  // Speed rule:
  // Skip AI only for small, complete imports that already mention enough ingredients.
  // This keeps simple recipes fast while still cleaning vague instructions.
  // -----------------------------------------------------

  const shouldSkipAiCleanup =
    result.successLevel === "full" &&
    ingredientCount <= 12 &&
    instructionCount <= 8 &&
    instructionsAlreadyUseful;

  if (shouldSkipAiCleanup) {
    result.aiCleanup = {
      enabled: false,
      skipped: true,
      reason: "simple-full-import",
      ingredientsCount: ingredientCount,
      instructionsCount: instructionCount,
      instructionsAlreadyUseful,
    };

    result.debug = {
      ...(result.debug || {}),
      aiCleanupSkipped: true,
      instructionsAlreadyUseful,
    };

    console.log("AI cleanup skipped:", {
      reason: "simple-full-import",
      ingredientsCount: ingredientCount,
      instructionsCount: instructionCount,
      instructionsAlreadyUseful,
    });

    return result;
  }

  const aiStartedAt = Date.now();

  const cleanedRecipe = await cleanRecipeWithAI(result.recipe);

  const cleanedIngredients = cleanedRecipe.ingredients
    .map(removeSecondaryMeasurements)
    .map(cleanHtmlEntities)
    .map(cleanText)
    .map(fixBrokenCommonWords)
    .flatMap(splitEachIngredient)
    .filter(Boolean);

  const cleanedInstructions = splitLongInstructionSteps(cleanedRecipe.instructions)
    .map(removeSecondaryMeasurements)
    .map(cleanHtmlEntities)
    .map(cleanText)
    .map(normalizeCookingText)
    .map(fixBrokenCommonWords)
    .filter(Boolean)
    .filter(
      (step) =>
        !/^pro tip:/i.test(step) &&
        !/^this soup freezes/i.test(step) &&
        !/^this allows leftover/i.test(step) &&
        !/^this will yield/i.test(step) &&
        !/^refer to package/i.test(step) &&
        !/^\(?refer to package/i.test(step) &&
        !/^see this video/i.test(step) &&
        !/^any rice stuck/i.test(step) &&
        !/^note: other varieties of rice/i.test(step)
    );

  if (cleanedIngredients.length > 0) {
    result.ingredients = cleanedIngredients;
    result.recipe.ingredients = cleanedIngredients.join("\n");
  }

  if (cleanedInstructions.length > 0) {
    result.instructions = cleanedInstructions;
    result.recipe.instructions = cleanedInstructions.join("\n");
  }

  const cleanedEffort = normalizeEffort(cleanedRecipe.effort);
  const cleanedTags = normalizeTags(cleanedRecipe.tags);
  const cleanedIsVegetarian = normalizeBoolean(cleanedRecipe.isVegetarian);
  const cleanedNotes = normalizeRecipeNotes(cleanedRecipe.notes);

  result.recipe.effort = cleanedEffort;
  result.recipe.tags = cleanedTags;
  result.recipe.isVegetarian = cleanedIsVegetarian;

  if (cleanedNotes) {
    result.recipe.notes = cleanedNotes;
  }

  result.effort = cleanedEffort;
  result.tags = cleanedTags;
  result.isVegetarian = cleanedIsVegetarian;
  result.notes = cleanedNotes;

  result.aiCleanup = {
    enabled: true,
    ingredientsCount: cleanedIngredients.length,
    instructionsCount: cleanedInstructions.length,
    metadataDetected: true,
  };

  result.debug = {
    ...(result.debug || {}),
    aiCleanupApplied: true,
    instructionsAlreadyUseful,
  };

  console.log("AI cleanup finished:", {
    seconds: Math.round((Date.now() - aiStartedAt) / 1000),
    ingredientsCount: cleanedIngredients.length,
    instructionsCount: cleanedInstructions.length,
    instructionsAlreadyUseful,
  });

  return result;
}

async function enhanceInstructionsWithMeasurements(recipe) {
  try {
    if (!process.env.OPENAI_API_KEY) return recipe.instructions.split("\n");

    const prompt = `
Rewrite these recipe instructions to include ingredient amounts where helpful.

RULES:
- Use ONLY the ingredient amounts provided.
- Do NOT invent ingredients or measurements.
- Keep steps natural and concise.
- Keep the same cooking meaning.
- Return valid JSON only.

Return format:
{
  "instructions": ["..."]
}

Ingredients:
${recipe.ingredients}

Instructions:
${recipe.instructions}
`;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      messages: [
        {
          role: "system",
          content:
            "You improve recipe instructions for Cook Mode by adding existing ingredient measurements where helpful.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(content);

    return Array.isArray(parsed.instructions)
      ? parsed.instructions
      : recipe.instructions.split("\n");
  } catch (err) {
    console.error("Measurement instruction enhancement failed:", err);
    return recipe.instructions.split("\n");
  }
}

// =====================================================
// Blocked-site detection
// Prevents importing bot-check / access denied pages as recipes
// =====================================================

function isBlockedPage($, finalUrl = "") {
  const title = cleanText($("title").text()).toLowerCase();
  const body = cleanText($("body").text()).toLowerCase();

  return (
    title.includes("just a moment") ||
    title.includes("access denied") ||
    title.includes("access to this page has been denied") ||
    body.includes("just a moment") ||
    body.includes("checking your browser") ||
    body.includes("access to this page has been denied") ||
    body.includes("please enable cookies") ||
    body.includes("verify you are human") ||
    body.includes("attention required") ||
    finalUrl.includes("js_challenge=1") ||
    finalUrl.includes("solution=") ||
    body.includes("blocked by network security") ||
    body.includes("whoa there, pardner")
  );
}

// =====================================================
// JSON-LD recipe discovery
// Handles Recipe objects nested in arrays, @graph, etc.
// =====================================================

function findRecipe(value) {
  if (!value) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecipe(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  const type = value["@type"];

  const isRecipeType =
    type === "Recipe" ||
    (Array.isArray(type) && type.some((t) => String(t).toLowerCase() === "recipe"));

  const looksLikeRecipe =
    value.recipeIngredient ||
    value.recipeInstructions ||
    value.cookTime ||
    value.prepTime;

  if (isRecipeType || looksLikeRecipe) {
    return value;
  }

  if (Array.isArray(value["@graph"])) {
    for (const item of value["@graph"]) {
      const found = findRecipe(item);
      if (found) return found;
    }
  }

  for (const key of Object.keys(value)) {
    const child = value[key];

    if (child && typeof child === "object") {
      const found = findRecipe(child);
      if (found) return found;
    }
  }

  return null;
}

// =====================================================
// Instruction extraction
// Handles string, array, HowToStep, HowToSection, etc.
// =====================================================

function extractInstructions(input) {
  if (!input) return [];

  if (typeof input === "string") {
    return [cleanText(input)].filter(Boolean);
  }

  if (Array.isArray(input)) {
    return input
      .flatMap((item) => extractInstructions(item))
      .map(cleanText)
      .filter(Boolean);
  }

  if (typeof input === "object") {
    if (input.itemListElement) {
      const nested = extractInstructions(input.itemListElement);
      if (nested.length > 0) return nested;
    }

    if (input.text) return extractInstructions(input.text);
    if (input.name) return extractInstructions(input.name);
  }

  return [];
}

// =====================================================
// Image extraction
// Handles strings, arrays, and schema image objects
// =====================================================

function extractImage(input) {
  if (!input) return "";

  if (typeof input === "string") return input;

  if (Array.isArray(input)) {
    for (const item of input) {
      const found = extractImage(item);
      if (found) return found;
    }
    return "";
  }

  if (typeof input === "object") {
    return input.url || input.contentUrl || input.thumbnailUrl || "";
  }

  return "";
}

// =====================================================
// Selector fallback extraction
// Used when JSON-LD is missing or incomplete
// =====================================================

function extractBySelectors($, selectors) {
  const results = [];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const text = cleanHtmlEntities(cleanText($(el).text()));
      if (text) results.push(text);
    });

    if (results.length > 0) break;
  }

  return Array.from(new Set(results));
}

// =====================================================
// Allrecipes article-to-recipe link detection
// Finds the real recipe page from article pages
// =====================================================

function findAllrecipesRecipeLink($, baseUrl, articleTitle = "") {
  let found = "";

  const normalizedTitle = cleanText(articleTitle)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();

  const titleWords = normalizedTitle
    .split(/\s+/)
    .filter((word) => word.length > 3);

  $("a").each((_, el) => {
    if (found) return;

    const text = cleanText($(el).text()).toLowerCase();
    const href = $(el).attr("href");

    if (!href || !href.includes("/recipe/")) return;

    const score = titleWords.reduce((total, word) => {
      return text.includes(word) ? total + 1 : total;
    }, 0);

    if (text.includes("get the recipe") || score >= 2) {
      try {
        found = new URL(href, baseUrl).toString();
      } catch {
        // Ignore invalid URL
      }
    }
  });

  return found;
}

// =====================================================
// Natasha's Kitchen fallback parser
// Used if Natasha becomes accessible instead of blocked
// =====================================================

function extractNatashaIngredients($) {
  const results = [];

  [
    ".wprm-recipe-ingredient",
    ".wprm-recipe-ingredients li",
    "[class*='wprm-recipe-ingredient']",
  ].forEach((selector) => {
    $(selector).each((_, el) => {
      const text = cleanHtmlEntities(cleanText($(el).text()));
      if (text && !results.includes(text)) results.push(text);
    });
  });

  return results.slice(0, 80);
}

function extractNatashaInstructions($) {
  const results = [];

  [
    ".wprm-recipe-instruction",
    ".wprm-recipe-instructions li",
    "[class*='wprm-recipe-instruction']",
  ].forEach((selector) => {
    $(selector).each((_, el) => {
      const text = cleanHtmlEntities(cleanText($(el).text()));
      if (text && !results.includes(text)) results.push(text);
    });
  });

  return results.filter((line) => line.length > 10).slice(0, 40);
}

// =====================================================
// Screenshot AI vision helpers
// Extract visible recipe text from uploaded screenshots
// =====================================================

function imageBufferToDataUrl(buffer, mimetype) {
  return `data:${mimetype};base64,${buffer.toString("base64")}`;
}

async function extractRecipeTextFromScreenshots(
  screenshots,
  {
    sourceUrl = "",
    sourceTitle = "",
    language = "en",
  } = {}
) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    throw new Error("At least one screenshot is required.");
  }

  const content = [
    {
      type: "text",
      text: `
You are helping Simple Dinners extract recipe text from screenshots.

The screenshots may come from:
- social media recipe posts
- recipe websites
- recipe apps
- notes
- messages
- printed recipe photos

Your job:
Faithfully extract the visible recipe-related text.

PRIORITIES:
1. Capture the recipe title if visible.
2. Capture ingredients exactly as shown when possible.
3. Capture instructions exactly as shown when possible.
4. Capture servings/yield if visible.
5. Merge overlapping screenshots without duplicating repeated lines.

STRICT RULES:
- Do NOT invent missing ingredients.
- Do NOT invent missing instructions.
- Do NOT complete cut-off lines.
- Do NOT rewrite the recipe into a nicer format.
- Do NOT include social media UI text, comments, likes, timestamps, usernames, buttons, or unrelated promotional text unless it is clearly part of the recipe.
- If the screenshots appear incomplete, say so in the warnings.
- If no recipe is visible, say so.

Return valid JSON only in this format:
{
  "hasRecipeContent": true,
  "title": "Recipe title if visible",
  "servings": "Servings if visible, otherwise empty string",
  "extractedText": "All visible recipe text in a clean readable block",
  "ingredientsAppearComplete": true,
  "instructionsAppearComplete": true,
  "possibleMissingBeginning": false,
  "possibleMissingEnding": false,
  "warnings": ["optional warning"]
}

COMPLETENESS RULES:
- ingredientsAppearComplete means the visible ingredient list appears to include all recipe ingredients.
- instructionsAppearComplete means the visible cooking method appears to reach the end of the recipe.
- A missing recipe title does NOT make ingredients or instructions incomplete.
- Missing servings do NOT make ingredients or instructions incomplete.
- Optional notes, storage tips, substitutions, nutrition, or serving commentary continuing below the screenshots do NOT make the core recipe incomplete.
- Set ingredientsAppearComplete or instructionsAppearComplete to false only when that specific recipe section appears visibly cut off or missing.

Helpful context:
- sourceTitle: ${sourceTitle || ""}
- sourceUrl: ${sourceUrl || ""}
- language: ${language || "en"}
      `.trim(),
    },
  ];

  for (const screenshot of screenshots) {
    content.push({
      type: "image_url",
      image_url: {
        url: imageBufferToDataUrl(screenshot.buffer, screenshot.mimetype),
      },
    });
  }

  const response = await openai.chat.completions.create({
    model:
      process.env.OPENAI_VISION_MODEL ||
      process.env.OPENAI_MODEL ||
      "gpt-5.5",
    messages: [
      {
        role: "system",
        content:
          "You faithfully transcribe recipe content from screenshots for Simple Dinners. Return valid JSON only.",
      },
      {
        role: "user",
        content,
      },
    ],
  });

  const raw = response.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(raw);

  return {
    hasRecipeContent: parsed?.hasRecipeContent === true,
    title: String(parsed?.title || "").trim(),
    servings: String(parsed?.servings || "").trim(),
    extractedText: String(parsed?.extractedText || "").trim(),
    ingredientsAppearComplete:
      parsed?.ingredientsAppearComplete === true,

    instructionsAppearComplete:
      parsed?.instructionsAppearComplete === true,
    possibleMissingBeginning: parsed?.possibleMissingBeginning === true,
    possibleMissingEnding: parsed?.possibleMissingEnding === true,
    warnings: Array.isArray(parsed?.warnings)
      ? parsed.warnings.map((item) => String(item).trim()).filter(Boolean)
      : [],
  };
}

// =====================================================
// Smart Week request interpretation
// AI translates the user's optional sentence into a
// small validated constraint object. Recipe selection
// remains deterministic in the frontend planner.
// =====================================================

const SMART_WEEK_ALLOWED_TAGS = new Set([
  "chicken",
  "beef",
  "pork",
  "seafood",
  "fish",
  "pasta",
  "rice",
  "tacos",
  "soup",
  "salad",
  "casserole",
  "comfort",
  "family",
  "kid-friendly",
  "quick",
  "easy",
  "oven",
  "stovetop",
  "slow-cooker",
  "crockpot",
  "air-fryer",
  "grilling",
  "sheet-pan",
  "one-pot",
  "vegetarian",
  "healthy",
  "spicy",
  "italian",
  "mexican",
  "asian",
  "freezer-friendly",
  "gluten-free",
  "low-carb",
]);

function stripJsonCodeFence(value) {
  return String(value || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeSmartWeekStringList(
  value,
  maximumItems = 12,
) {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) =>
          String(item || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean)
        .map((item) => item.slice(0, 50)),
    ),
  ).slice(0, maximumItems);
}

function normalizeSmartWeekTags(value) {
  return normalizeSmartWeekStringList(value)
    .map((tag) =>
      tag.replace(/\s+/g, "-"),
    )
    .filter((tag) =>
      SMART_WEEK_ALLOWED_TAGS.has(tag),
    );
}

function normalizeSmartWeekProteinTargets(value) {
  if (!Array.isArray(value)) return [];

  const targets = [];

  for (const item of value) {
    const keyword = String(
      item?.keyword || "",
    )
      .trim()
      .toLowerCase()
      .slice(0, 40);

    const rawCount = Number(item?.count);
    const count = Number.isFinite(rawCount)
      ? Math.max(
        1,
        Math.min(7, Math.round(rawCount)),
      )
      : 1;

    if (!keyword) continue;

    targets.push({
      keyword,
      count,
    });
  }

  const seen = new Set();

  return targets
    .filter((target) => {
      if (seen.has(target.keyword)) {
        return false;
      }

      seen.add(target.keyword);
      return true;
    })
    .slice(0, 4);
}

function normalizeSmartWeekRequestConstraints(
  value,
) {
  const rawVegetarianCount = Number(
    value?.vegetarianNightCount,
  );

  const vegetarianNightCount =
    Number.isFinite(rawVegetarianCount)
      ? Math.max(
        0,
        Math.min(
          7,
          Math.round(rawVegetarianCount),
        ),
      )
      : 0;

  return {
    excludedKeywords:
      normalizeSmartWeekStringList(
        value?.excludedKeywords,
      ),

    preferredKeywords:
      normalizeSmartWeekStringList(
        value?.preferredKeywords,
      ),

    preferredTags:
      normalizeSmartWeekTags(
        value?.preferredTags,
      ),

    mostlyQuick:
      value?.mostlyQuick === true,

    vegetarianNightCount,

    pantryPriority:
      value?.pantryPriority === true,

    budgetPriority:
      value?.budgetPriority === true,

    kidFriendly:
      value?.kidFriendly === true,

    proteinTargets:
      normalizeSmartWeekProteinTargets(
        value?.proteinTargets,
      ),
  };
}

async function interpretSmartWeekRequestWithAI(
  requestText,
  language = "en",
) {
  if (!openai) {
    throw new Error(
      "OPENAI_API_KEY is not set.",
    );
  }

  const prompt = `
Interpret one optional weekly dinner-planning request for Simple Dinners.

The user may write in English or Spanish.

Your job is ONLY to translate the request into structured planning guidance.
Do not select recipes.
Do not invent recipe names.
Do not weaken dietary restrictions.
Do not infer allergies or medical restrictions that the user did not explicitly state.

INTERPRETATION RULES:

- excludedKeywords:
  Include foods or meal types the user explicitly says to avoid, exclude, or not use.
  Example: "No seafood" may include seafood-related exclusion keywords.
  Do not treat a positive request as an exclusion.

- preferredKeywords:
  Include explicitly requested ingredients, proteins, cuisines, or meal styles.

- preferredTags:
  Use only tags that clearly match the request.

- mostlyQuick:
  True when the user asks for mostly quick, easy, simple, or low-effort meals.

- vegetarianNightCount:
  Use the explicitly requested number.
  "One vegetarian night" becomes 1.
  Do not make the whole week vegetarian unless explicitly requested.

- pantryPriority:
  True when the user asks to use ingredients already available, use the pantry, reduce waste, or use something before it expires.

- budgetPriority:
  True when the user asks for inexpensive, affordable, cheap, economical, or budget-friendly meals.

- kidFriendly:
  True when the user requests kid-friendly, family-friendly, picky-eater-friendly, or child-friendly meals.

- proteinTargets:
  Use only for an explicit requested count.
  Example: "Use chicken twice" becomes:
  [{ "keyword": "chicken", "count": 2 }]

Return valid JSON only:

{
  "excludedKeywords": [],
  "preferredKeywords": [],
  "preferredTags": [],
  "mostlyQuick": false,
  "vegetarianNightCount": 0,
  "pantryPriority": false,
  "budgetPriority": false,
  "kidFriendly": false,
  "proteinTargets": []
}

Request language:
${language}

User request:
${requestText}
  `.trim();

  const response =
    await openai.chat.completions.create({
      model:
        process.env.OPENAI_MODEL ||
        "gpt-5.5",

      messages: [
        {
          role: "system",
          content:
            "You interpret optional dinner-planning requests for Simple Dinners. Return valid JSON only and never select or invent recipes.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

  const content =
    response.choices?.[0]?.message
      ?.content || "";

  const parsed = JSON.parse(
    stripJsonCodeFence(content),
  );

  return normalizeSmartWeekRequestConstraints(
    parsed,
  );
}

// =====================================================
// Text helpers
// =====================================================

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&frac12;/gi, "½")
    .replace(/&frac14;/gi, "¼")
    .replace(/&frac34;/gi, "¾")
    .replace(/&#160;/g, " ")
    .replace(/&#176;/g, "°")
    .replace(/&#188;/g, "¼")
    .replace(/&#189;/g, "½")
    .replace(/&#190;/g, "¾")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => {
      return String.fromCharCode(Number(code));
    })
    .trim();
}

function cleanRecipeNoteText(value) {
  return String(value || "")
    .replace(/^\(Note:\s*/i, "Note: ")
    .replace(/^\(Note\s*/i, "Note: ")
    .replace(/\)+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEffort(value) {
  const effort = String(value || "").toLowerCase().trim();

  if (effort === "quick") return "quick";
  if (effort === "big") return "big";

  return "normal";
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];

  const allowedTags = new Set([
    "air-fryer",
    "asian",
    "beef",
    "breakfast",
    "casserole",
    "chicken",
    "comfort",
    "crockpot",
    "dessert",
    "dinner",
    "easy",
    "family",
    "fish",
    "freezer-friendly",
    "gluten-free",
    "grilling",
    "healthy",
    "italian",
    "kid-friendly",
    "low-carb",
    "lunch",
    "mexican",
    "one-pot",
    "oven",
    "pasta",
    "pork",
    "quick",
    "rice",
    "salad",
    "seafood",
    "sheet-pan",
    "side",
    "slow-cooker",
    "soup",
    "spicy",
    "stovetop",
    "tacos",
    "vegetarian",
  ]);

  return Array.from(
    new Set(
      tags
        .map((tag) =>
          String(tag || "")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "-")
        )
        .filter((tag) => allowedTags.has(tag))
    )
  ).slice(0, 8);
}

function normalizeBoolean(value) {
  return value === true;
}

function normalizeRecipeNotes(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function slugify(text) {
  return String(text || "recipe")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function splitLongInstructionSteps(instructions) {
  return instructions.flatMap((step) => {
    const text = cleanRecipeNoteText(cleanText(step));

    if (text.length < 220) return [text];

    return text
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((part) => cleanRecipeNoteText(part))
      .filter(Boolean)
      .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`));
  });
}

function splitEachIngredient(ingredient) {
  const match = ingredient.match(
    /^(.+?)\s+EACH:\s+(.+)$/i
  );

  if (!match) return [ingredient];

  const amount = match[1].trim();

  return match[2]
    .split(",")
    .map(item => `${amount} ${item.trim()}`);
}

function normalizeCookingText(text) {
  return String(text || "")
    .replace(/(\d+)\s*degrees\b/gi, "$1°F")
    .replace(/(\d+)\s*degree\b/gi, "$1°F")
    .replace(/\s+/g, " ")
    .replace(/\(Discard the bones\.\)\s*Return it to the soup\./gi,
      "Discard the bones, then return the shredded chicken to the soup.")
    .trim();
}

function fixBrokenCommonWords(text) {
  return String(text || "")
    .replace(/\bth\s+e\b/gi, "the")
    .replace(/\bwh\s+en\b/gi, "when")
    .replace(/\bov\s+er\b/gi, "over")
    .replace(/\bund\s+er\b/gi, "under")
    .replace(/\brem\s+aining\b/gi, "remaining")
    .replace(/\btom\s+atoes\b/gi, "tomatoes")
    .replace(/\bto\s+matoes\b/gi, "tomatoes")
    .replace(/\bch\s+icken\b/gi, "chicken")
    .replace(/\bbl\s+ack\b/gi, "black")
    .replace(/\bb\s+lack\b/gi, "black")
    .replace(/\bl\s+ack\b/gi, "black")
    .replace(/\bcl\s+ove\b/gi, "clove")
    .replace(/\bfr\s+esh\b/gi, "fresh")
    .replace(/\bmozz\s+arella\b/gi, "mozzarella")
    .replace(/\boregano\b/gi, "oregano")
    .replace(/\bregano\b/gi, "oregano")
    .replace(/\s+/g, " ")
    .trim();
}

async function parseRecipeTextWithAI(text) {
  const prompt = `
Extract ONE clean, structured recipe from this pasted text.

The pasted text may be messy. It may include:
- blog stories
- ads
- comments
- nutrition text
- social media prompts
- "jump to recipe"
- "pin this recipe"
- related recipe links
- repeated recipe card content
- duplicate ingredient or instruction sections
- full webpage text copied from a recipe site

PRIMARY GOAL:
Find the main recipe and convert it into a clean Simple Dinners recipe.

RULES:
- Extract only the main recipe.
- Ignore blog commentary, ads, comments, nutrition disclaimers, social prompts, related recipes, and promotional text.
- Prefer the most complete recipe card if the text contains repeated sections.
- Do not include "Ingredients:", "Instructions:", "Notes:", "Nutrition:", or similar labels as standalone items.
- Preserve meaningful ingredient section labels by placing them inside the ingredients array as simple headings ending with a colon.
  Example: "Chicken:", "Bruschetta:", "Dressing:", "Sauce:", "Topping:"
- Keep ingredient lines directly under their section heading.
- Do not flatten separate ingredient sections into one confusing list if the recipe clearly has sections.
- Remove duplicate ingredient lines caused by repeated copied page content.
- Do not remove similar ingredients when they belong to different sections.
  Example: "1 clove garlic" for chicken and "2 cloves garlic" for topping may both be valid.
- Extract cooking steps only into the instructions array.
- Do not invent ingredients, measurements, or cooking steps.
- Keep ingredient measurements exactly as provided when possible.
- Keep package sizes when meaningful.
  Example: keep "2 (14 oz) cans".
- It is okay to remove secondary metric conversions when there is already a clear US measurement.
  Example: "10.5 oz (300 g)" may become "10.5 oz".
- Return valid JSON only.

COOK MODE INSTRUCTION RULES:
- Instructions should be clear, natural, and Cook Mode friendly.
- Include ingredient measurements in instructions when helpful.
- Use ONLY measurements found in the pasted recipe text.
- Do not invent amounts.
- Split overloaded steps into smaller steps when multiple unrelated actions are combined.
- Do not mash marinade, topping, sauce, garnish, and serving steps into one giant instruction.
- Prefer one main cooking action per instruction step.
- Keep steps concise but useful.
- Each instruction should be understandable without constantly checking the ingredient list.

Return format:
{
  "name": "...",
  "ingredients": ["..."],
  "instructions": ["..."]
}

Pasted text:
${text}
`;

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-5.5",
    messages: [
      {
        role: "system",
        content:
          "You extract clean, structured recipes from messy pasted webpage text for Simple Dinners, a meal planning and Cook Mode app.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content || "";
  return JSON.parse(content);
}

function removeSecondaryMeasurements(text) {
  return String(text || "")
    .replace(
      /(\d[\d\/.\s]*(?:oz|ounces?|cups?|tbsp|tablespoons?|tsp|teaspoons?|lb|lbs|pounds?))\s*\([^)]*(?:g|grams|kg|ml|milliliters?|l|liters?)[^)]*\)/gi,
      "$1"
    )
    .replace(/\s+/g, " ")
    .trim();
}
// =====================================================
// AI Recipe Cleanup
// Cleans imported recipe formatting
// =====================================================

async function cleanRecipeWithAI(recipe) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return {
        ingredients: recipe.ingredients.split("\n"),
        instructions: recipe.instructions.split("\n"),
        effort: recipe.effort || "normal",
        tags: Array.isArray(recipe.tags) ? recipe.tags : [],
        isVegetarian: recipe.isVegetarian === true,
        notes: recipe.notes || "",
      };
    }

    const prompt = `
You are cleaning and standardizing a recipe for Simple Dinners, a meal planning and Cook Mode app.

PRIMARY GOAL:
Make the recipe feel like a native Simple Dinners recipe:
- clean ingredient list
- clear ingredient sections when useful
- natural Cook Mode-friendly instructions
- ingredient measurements included in instructions when helpful

STRICT RULES:
- Do NOT invent ingredients.
- Do NOT invent measurements.
- Do NOT invent cooking steps.
- Keep the recipe faithful to the original.
- Use only ingredients, amounts, and steps already present in the recipe text.
- Return valid JSON only.

INGREDIENT RULES:
- Normalize capitalization and spacing.
- Remove duplicate ingredient lines caused by messy imports.
- Preserve meaningful ingredient section headings.
  Example: "Chicken:", "Bruschetta:", "Sauce:", "Dressing:", "Topping:", "Finish:"
- Section headings should be included in the ingredients array as their own item ending with a colon.
- Do not include generic labels like "Ingredients:" as a heading.
- Do not flatten separate sections if the recipe clearly has multiple parts.
- Do not delete similar ingredients when they belong to different sections.
  Example: garlic in a marinade and garlic in a topping can both remain.
- Remove promotional, blog, nutrition, storage, comment, and unrelated webpage text.
- Keep meaningful package sizing.
  Example: "2 (14 oz) cans diced tomatoes".
- Remove duplicate metric conversions when a clear US measurement exists.
  Example: "10.5 oz (300 g)" can become "10.5 oz".
  - Convert metric measurements to common US cooking measurements when practical. Prefer cups, tablespoons, teaspoons, ounces, pounds, or common package sizes. Keep conversions natural and approximate when needed.
- For weight-based ingredients like meat, noodles, cheese, tofu, or packaged foods, prefer ounces or pounds.
- For chopped vegetables, fruit, herbs, and loose ingredients, cups are often better when reasonable.
- Do not invent exact precision. Use "about" when the conversion is approximate.
- Examples:
  "350 g mixed vegetables" can become "about 3 cups mixed vegetables".
  "410 g fresh egg noodles" can become "about 14 oz fresh egg noodles".
  "15 ml soy sauce" can become "1 tbsp soy sauce".
  "5 ml sesame oil" can become "1 tsp sesame oil".

INSTRUCTION RULES:
- Make instructions Cook Mode friendly.
- Include ingredient measurements in instructions when helpful.
- Use ONLY measurements from the ingredient list or original recipe text.
- Do not force every measurement into every step.
- Add measurements naturally, not awkwardly.
- When converting metric measurements in ingredients, also use the converted US-friendly measurement in the instructions so Cook Mode stays consistent.
- Split overloaded steps into smaller, clearer steps.
- When a step combines more than 5 ingredients, split it into 2 smaller steps if there is a natural break, such as wet ingredients first, seasonings/aromatics second, or adding the main protein/vegetables after mixing the marinade, sauce, or topping.
- Fix broken spacing inside common words caused by copied webpage text, such as "th e" becoming "the" and "tom atoes" becoming "tomatoes".
- Prefer one main cooking action per instruction step.
- Do not combine marinade, topping, sauce, garnish, and serving steps into one giant instruction.
- Keep instructions concise, but useful enough that the cook does not need to constantly jump back to the ingredient list.
- Standardize temperatures using °F.
- Standardize time wording like "4 to 5 minutes".
- Remove non-actionable commentary unless it is an important cooking note.

GOOD EXAMPLES:
- "Add mushrooms and cook until browned" should become "Add 16 oz mushrooms and cook 6 to 8 minutes, until browned."
- "Stir in cream and parmesan" should become "Stir in 1/2 cup heavy cream and 1/2 cup grated parmesan."
- "Cook chicken with seasoning" should become "Cook 1 lb chicken with 1 tbsp seasoning" only if those amounts exist in the ingredients.

BAD EXAMPLES:
- Do not create a giant step that combines every ingredient in the recipe.
- Do not add measurements that are not listed.
- Do not include "Jump to Recipe", "Pin this", "Subscribe", "Nutrition", or blog text.
- Do not turn section headings into cooking steps.

METADATA RULES:
- Choose effort as exactly one of: "quick", "normal", or "big".
- Use "quick" for recipes that are simple, mostly hands-off, or usually done in about 30 minutes or less.
- Use "normal" for typical weeknight dinners with moderate prep or cook time.
- Use "big" for recipes with long cook times, many components, smoking, slow roasting, complicated prep, or special effort.
- Add 3 to 8 useful tags.
- Tags should be lowercase and practical for browsing.
- Prefer tags from this list when they apply:
  dinner, chicken, beef, pork, seafood, fish, pasta, rice, tacos, soup, salad, casserole, comfort, family, kid-friendly, quick, easy, oven, stovetop, slow-cooker, crockpot, air-fryer, grilling, sheet-pan, one-pot, vegetarian, healthy, spicy, italian, mexican, asian, breakfast, lunch, side, dessert, freezer-friendly, gluten-free, low-carb
- Set isVegetarian to true only if the recipe has no meat, poultry, seafood, fish, or meat-based broth.
- Write one short notes sentence that explains what makes the recipe useful, flavorful, or worth making.
- Do not mention that the recipe was imported.
- Do not include source website commentary.

Return format:
{
  "ingredients": ["..."],
  "instructions": ["..."],
  "effort": "quick",
  "tags": ["dinner", "chicken", "comfort"],
  "isVegetarian": false,
  "notes": "A short helpful recipe note."
}

Recipe:

Title:
${recipe.name}

Ingredients:
${recipe.ingredients}

Instructions:
${recipe.instructions}
`;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      messages: [
        {
          role: "system",
          content:
            "You clean and standardize recipes for Simple Dinners. Preserve measurements for Cook Mode and keep recipes faithful to the original.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content || "";
    const cleaned = JSON.parse(content);


    // =====================================================
    // Split giant instruction blobs into multiple steps
    // =====================================================

    if (
      Array.isArray(cleaned.instructions) &&
      cleaned.instructions.length === 1
    ) {
      cleaned.instructions = cleaned.instructions[0]
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+/)
        .map((step) => step.trim())
        .filter(Boolean)
        .map((step) => (/[.!?]$/.test(step) ? step : `${step}.`));
    }

    return {
      ingredients: Array.isArray(cleaned.ingredients)
        ? cleaned.ingredients
        : recipe.ingredients.split("\n"),

      instructions: Array.isArray(cleaned.instructions)
        ? cleaned.instructions
        : recipe.instructions.split("\n"),

      effort: cleaned.effort || recipe.effort || "normal",

      tags: Array.isArray(cleaned.tags)
        ? cleaned.tags
        : Array.isArray(recipe.tags)
          ? recipe.tags
          : [],

      isVegetarian:
        typeof cleaned.isVegetarian === "boolean"
          ? cleaned.isVegetarian
          : recipe.isVegetarian === true,

      notes: cleaned.notes || recipe.notes || "",
    };
  } catch (err) {
    console.error("AI cleanup failed:", err);

    return {
      ingredients: recipe.ingredients.split("\n"),
      instructions: recipe.instructions.split("\n"),
      effort: recipe.effort || "normal",
      tags: Array.isArray(recipe.tags) ? recipe.tags : [],
      isVegetarian: recipe.isVegetarian === true,
      notes: recipe.notes || "",
    };
  }
}

// =====================================================
// Server start
// =====================================================

const port = process.env.PORT || 3000;

app.listen({ port, host: "0.0.0.0" });