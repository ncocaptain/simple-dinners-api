// =====================================================
// Simple Dinners API
// Backend importer using Fastify + Playwright + Cheerio
// =====================================================

import Fastify from "fastify";
import { chromium } from "playwright";
import * as cheerio from "cheerio";

// =====================================================
// App setup
// =====================================================

const app = Fastify({ logger: true });

app.get("/", async () => {
  return {
    ok: true,
    name: "Simple Dinners API",
    version: "simple-dinners-api-importer-v1",
  };
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

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1365, height: 900 },
      locale: "en-US",
    });

    const page = await context.newPage();

    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    const firstResult = await loadAndExtractRecipe(page, url);

    const shouldFollowLinkedRecipe =
      firstResult.linkedRecipeUrl && firstResult.ingredients.length === 0;

    if (shouldFollowLinkedRecipe) {
      const linkedResult = await loadAndExtractRecipe(
        page,
        firstResult.linkedRecipeUrl
      );

      return {
        ...linkedResult,
        sourceUrl: url,
        importedFromUrl: firstResult.linkedRecipeUrl,
        recipe: {
          ...linkedResult.recipe,
          sourceUrl: firstResult.linkedRecipeUrl,
        },
        debug: {
          ...linkedResult.debug,
          followedLinkedRecipe: true,
          originalUrl: url,
          firstPageName: firstResult.name,
        },
      };
    }

    return firstResult;
  } catch (error) {
    request.log.error(error);

    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : "Import failed",
    });
  } finally {
    if (browser) await browser.close();
  }
});

// =====================================================
// Page loading + extraction pipeline
// =====================================================

async function loadAndExtractRecipe(page, url) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  await page.waitForTimeout(6000);

  const html = await page.content();
  const finalUrl = page.url();
  const $ = cheerio.load(html);

  return extractRecipeFromPage($, url, finalUrl);
}

function extractRecipeFromPage($, sourceUrl, finalUrl) {
  let recipe = null;

  $("script[type='application/ld+json']").each((_, el) => {
    if (recipe) return;

    try {
      const raw = $(el).text();
      const parsed = JSON.parse(raw);
      const found = findRecipe(parsed);
      if (found) recipe = found;
    } catch {
      // Ignore invalid JSON-LD blocks
    }
  });

  const rawName =
    recipe?.name ||
    $("meta[property='og:title']").attr("content") ||
    $("title").text() ||
    "Imported Recipe";

  const recipeName = cleanHtmlEntities(cleanText(rawName));

  let ingredients = Array.isArray(recipe?.recipeIngredient)
    ? recipe.recipeIngredient.map(cleanText).filter(Boolean)
    : [];

  let instructions = extractInstructions(recipe?.recipeInstructions);

  if (ingredients.length === 0) {
    ingredients = extractBySelectors($, [
      "[data-ingredient-name='true']",
      ".mntl-structured-ingredients__list-item",
      ".ingredients-item-name",
      "li[class*='ingredient']",
    ]);
  }

  if (instructions.length === 0) {
    instructions = extractBySelectors($, [
      ".comp.mntl-sc-block.mntl-sc-block-html",
      ".mntl-sc-block-group--LI",
      "li[class*='instruction']",
      "p[class*='instruction']",
      "div[class*='direction']",
    ]).filter((line) =>
      /mix|stir|cook|bake|heat|place|add|whisk|combine|pour|season|serve|remove|transfer|drain|spread|sprinkle|preheat/i.test(
        line
      )
    );
  }

  ingredients = ingredients.map(cleanHtmlEntities).map(cleanText).filter(Boolean);
  instructions = instructions.map(cleanHtmlEntities).map(cleanText).filter(Boolean);

  const image =
    extractImage(recipe?.image) ||
    $("meta[property='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content") ||
    "";

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
      : "metadata-only";

  return {
    success: true,
    successLevel,
    debugVersion: "simple-dinners-api-importer-v1",

    // Raw API fields for debugging/future use
    sourceUrl,
    importedFromUrl: finalUrl,
    name: recipeName,
    ingredients,
    instructions,
    image,
    linkedRecipeUrl,

    // Shape expected by Simple Dinners frontend
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
      fallbackText: "",
    },

    debug: {
      foundRecipe: !!recipe,
      ingredientsCount: ingredients.length,
      instructionsCount: instructions.length,
      finalUrl,
      linkedRecipeUrl,
    },
  };
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

  if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) {
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
    if (input.text) return extractInstructions(input.text);
    if (input.name) return extractInstructions(input.name);
    if (input.itemListElement) return extractInstructions(input.itemListElement);
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
    .trim();
}

function slugify(text) {
  return String(text || "recipe")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// =====================================================
// Server start
// =====================================================

const port = process.env.PORT || 3000;

app.listen({ port, host: "0.0.0.0" });