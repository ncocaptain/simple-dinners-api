// =====================================================
// Simple Dinners API
// Backend importer using Fastify + Playwright + Cheerio
// =====================================================

import Fastify from "fastify";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import {
  resolvePinterestRecipeUrl,
  isPinterestRecipeCandidate,
} from "./pinterestResolver.js";

// =====================================================
// App setup
// =====================================================

const app = Fastify({ logger: true });
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

app.get("/", async () => {
  return {
    ok: true,
    name: "Simple Dinners API",
    version: "simple-dinners-api-importer-v1",
  };
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
  const { url } = request.body || {};

  if (!url) {
    return reply.code(400).send({ error: "URL required" });
  }

  let importUrl = normalizeImportUrl(url);
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

    firstResult = await rescueSocialCaptionIfUseful(firstResult);

console.log("Recipe result after caption rescue check:", {
  successLevel: firstResult?.successLevel,
  name: firstResult?.name,
  ingredientsCount: firstResult?.ingredients?.length || 0,
  instructionsCount: firstResult?.instructions?.length || 0,
  socialCaptionRescue: firstResult?.debug?.socialCaptionRescue === true,
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

  const firstUrlMatch = value.match(/https?:\/\/[^\s]+/i);
  const candidate = firstUrlMatch ? firstUrlMatch[0] : value;

  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();

    const redirectParamNames = ["u", "url", "target", "redirect", "redirect_url"];

    for (const paramName of redirectParamNames) {
      const possibleRedirect = parsed.searchParams.get(paramName);

      if (possibleRedirect && /^https?:\/\//i.test(possibleRedirect)) {
        return normalizeImportUrl(possibleRedirect);
      }
    }

    if (
      host.includes("facebook.com") ||
      host.includes("fb.watch") ||
      host.includes("instagram.com") ||
      host.includes("tiktok.com") ||
      host.includes("pinterest.com")
    ) {
      return candidate;
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
    return candidate;
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

function stripSocialTitleNoise(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/#[\w-]+/g, " ")
    .replace(/@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBadSocialTitleCandidate(value) {
  const text = String(value || "").toLowerCase().trim();

  if (!text) return true;
  if (text.length < 3) return true;

  return (
    text.includes("ingredients:") ||
    text.includes("ingredient:") ||
    text.includes("instructions:") ||
    text.includes("directions:") ||
    text.includes("method:") ||
    text.includes("steps:") ||
    text.includes("serving ideas") ||
    text.includes("macros") ||
    text.includes("nutrition") ||
    text.includes("calories") ||
    text.includes("protein") ||
    text.includes("follow for") ||
    text.includes("comment") ||
    text.includes("save this") ||
    text.includes("share this") ||
    text.includes("link in bio")
  );
}

function findSocialTitleFromCaption(text) {
  const value = String(text || "").trim();

  if (!value) return "";

  const beforeRecipeSections = value
    .split(
      /ingredients?:|instructions?:|directions?:|method:|steps:|macros?:|nutrition:|serving ideas/i
    )[0]
    .trim();

  const candidates = beforeRecipeSections
    .split(/\n|\. |\|/)
    .map(stripSocialTitleNoise)
    .map((line) =>
      line
        .replace(/^[^\w]+/g, "")
        .replace(/[^\w\s&'-]+$/g, "")
        .trim()
    )
    .filter(Boolean);

  const bestCandidate = candidates.find((candidate) => {
    return candidate.length >= 4 && candidate.length <= 90 && !isBadSocialTitleCandidate(candidate);
  });

  return bestCandidate || "";
}

function cleanSocialRecipeTitle(name, fallbackText = "", sourceUrl = "") {
  const originalName = cleanHtmlEntities(cleanText(name || ""));
  const cleanedName = stripSocialTitleNoise(originalName);

  const suspiciousTitle =
    !cleanedName ||
    cleanedName.length > 90 ||
    isBadSocialTitleCandidate(cleanedName) ||
    /#/.test(originalName) ||
    /ingredients?:|instructions?:|directions?:|serving ideas|macros?:|nutrition:/i.test(
      originalName
    );

  if (!suspiciousTitle) {
    return cleanedName;
  }

  const titleFromCaption = findSocialTitleFromCaption(fallbackText);

  if (titleFromCaption) {
    return titleFromCaption;
  }

  const lowerUrl = String(sourceUrl || "").toLowerCase();

  if (lowerUrl.includes("instagram.com")) return "Instagram Recipe";
  if (lowerUrl.includes("tiktok.com")) return "TikTok Recipe";
  if (lowerUrl.includes("facebook.com") || lowerUrl.includes("fb.watch")) {
    return "Facebook Recipe";
  }

  return "Saved Social Recipe";
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
        : "Steps available at source link!",
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

if (isSocialSource) {
  recipeName = cleanSocialRecipeTitle(recipeName, description, finalUrl);
}

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
        : "Steps available at source link!",
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
  socialTitleCleaned: isSocialSource && originalRecipeName !== recipeName,
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
    result.recipe.instructions !== "Steps available at source link!";

  if (hasIngredients || hasInstructions) return false;

  return (
    result.successLevel === "metadata-only" ||
    result.successLevel === "social-metadata-only"
  );
}

function buildCaptionRescueText(result) {
  const parts = [
    result.name,
    result.recipe?.fallbackText,
    result.debug?.description,
    result.sourceUrl,
  ]
    .filter(Boolean)
    .map((part) => String(part).trim())
    .filter(Boolean);

  return Array.from(new Set(parts)).join("\n\n");
}

function looksLikeRecipeCaption(text) {
  const value = String(text || "").toLowerCase();

  if (value.length < 120) return false;

  const hasIngredientSignal =
    value.includes("ingredients:") ||
    value.includes("ingredient:") ||
    value.includes("you need") ||
    value.includes("what you need");

  const hasInstructionSignal =
    value.includes("instructions:") ||
    value.includes("directions:") ||
    value.includes("method:") ||
    value.includes("steps:") ||
    /\b1\s*[-.)]/.test(value) ||
    /1️⃣|2️⃣|3️⃣|4️⃣|5️⃣/.test(value);

  const hasCookingWords =
    /mix|stir|cook|bake|heat|add|combine|whisk|serve|marinate|drizzle|garnish|assemble/i.test(
      text
    );

  return hasIngredientSignal && (hasInstructionSignal || hasCookingWords);
}

async function rescueSocialCaptionIfUseful(result) {
  if (!resultNeedsCaptionRescue(result)) return result;

  const rescueText = buildCaptionRescueText(result);

  if (!looksLikeRecipeCaption(rescueText)) {
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

    const rescuedName = cleanSocialRecipeTitle(
  parsed.name || result.name || "Saved Recipe",
  rescueText,
  result.sourceUrl || result.importedFromUrl || result.recipe?.sourceUrl || ""
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
    return result;
  }
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
    result.recipe.instructions !== "Steps available at source link!";

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