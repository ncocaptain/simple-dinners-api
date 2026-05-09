// =====================================================
// Simple Dinners API
// Backend importer using Fastify + Playwright + Cheerio
// =====================================================

import Fastify from "fastify";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import OpenAI from "openai";

// =====================================================
// App setup
// =====================================================

const app = Fastify({ logger: true });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1365, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    const page = await context.newPage();

    const firstResult = await loadAndExtractRecipe(page, url);

    const shouldFollowLinkedRecipe =
      firstResult.success &&
      firstResult.linkedRecipeUrl &&
      firstResult.ingredients.length === 0;

    if (shouldFollowLinkedRecipe) {
      const linkedResult = await loadAndExtractRecipe(
        page,
        firstResult.linkedRecipeUrl
      );

      const finalResult = {
        ...linkedResult,
        sourceUrl: url,
        importedFromUrl: firstResult.linkedRecipeUrl,
        recipe: linkedResult.recipe
          ? {
              ...linkedResult.recipe,
              sourceUrl: firstResult.linkedRecipeUrl,
            }
          : null,
        debug: {
          ...linkedResult.debug,
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
// =====================================================

async function loadAndExtractRecipe(page, url) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  await page.waitForTimeout(4000);

  const html = await page.content();
  const finalUrl = page.url();
  const $ = cheerio.load(html);

  return extractRecipeFromPage($, url, finalUrl);
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
      ]).filter((line) =>
        /mix|stir|cook|bake|heat|place|add|whisk|combine|pour|season|serve|remove|transfer|drain|spread|sprinkle|preheat/i.test(
          line
        )
        .filter(step =>
  !/watch|video|subscribe|newsletter|follow|instagram|youtube/i.test(step)
)
.filter(step =>
  !/^pro tip:/i.test(step) &&
  !/^this soup freezes/i.test(step) &&
  !/^this will yield/i.test(step) &&
  !/^refer to package/i.test(step)
)
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

  const cleanedRecipe = await cleanRecipeWithAI(result.recipe);

  const cleanedIngredients = cleanedRecipe.ingredients
  .map(cleanHtmlEntities)
  .map(cleanText)
  .flatMap(splitEachIngredient)
  .filter(Boolean);

  const cleanedInstructions = splitLongInstructionSteps(cleanedRecipe.instructions)
  .map(cleanHtmlEntities)
  .map(cleanText)
  .map(normalizeCookingText)
  .filter(Boolean)
  .filter(step =>
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

  result.aiCleanup = {
    enabled: true,
    ingredientsCount: cleanedIngredients.length,
    instructionsCount: cleanedInstructions.length,
  };

  result.debug = {
    ...(result.debug || {}),
    aiCleanupApplied: true,
  };

  return result;
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

async function parseRecipeTextWithAI(text) {
  const prompt = `
Extract a structured recipe from this pasted text.

RULES:
- Identify the recipe name.
- Extract ingredients only into the ingredients array.
- Extract cooking steps only into the instructions array.
- Do not include section labels like "Ingredients:" or "Instructions:".
- Do not invent ingredients or steps.
- Return valid JSON only.

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
          "You extract structured recipes from pasted text for a meal planning app.",
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
      };
    }

    const prompt = `
You are cleaning and standardizing a recipe for a cooking app.

RULES:
- Do NOT invent ingredients.
- Do NOT invent cooking steps.
- Keep the recipe faithful to the original.
- Improve clarity and formatting.
- Normalize capitalization.
- Remove duplicate or messy wording.
- Make instructions easier to follow.
- If instructions are one long paragraph, you MUST split them into multiple short, numbered cooking steps.
- Each cooking action should usually become its own instruction step.
- Include ingredient measurements in instructions when helpful.
- Standardize temperatures using °F.
- Standardize time wording like "4 to 5 minutes".
- Keep instructions concise and Cook Mode friendly.
- Prefer one cooking action per instruction step.
- Format instructions similarly to a modern cooking app recipe.
- When an instruction clearly uses listed ingredients, include the ingredient amounts from the ingredient list when it improves clarity.
- Do not invent new amounts. Only use amounts already present in the ingredient list.
- Keep instructions natural and concise.
- Remove promotional content and non-essential blog commentary.
- Keep important cooking notes, but remove excessive storage or serving commentary.
- Prioritize actionable cooking instructions for Cook Mode.
- Return valid JSON only.

Return format:
{
  "ingredients": ["..."],
  "instructions": ["..."]
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
            "You clean and standardize cooking recipes for a meal planning app.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
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
    };
  } catch (err) {
    console.error("AI cleanup failed:", err);

    return {
      ingredients: recipe.ingredients.split("\n"),
      instructions: recipe.instructions.split("\n"),
    };
  }
}

// =====================================================
// Server start
// =====================================================

const port = process.env.PORT || 3000;

app.listen({ port, host: "0.0.0.0" });