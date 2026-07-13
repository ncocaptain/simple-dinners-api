// =====================================================
// Social Caption Resolver
// Pinterest-style candidate/filter/fallback helper for social recipe posts
// =====================================================

const FOOD_TITLE_WORDS =
  /\b(chicken|beef|shrimp|prawn|prawns|crab|salmon|pork|steak|sausage|turkey|tofu|rice|bowl|bowls|pasta|noodle|noodles|ramen|salad|soup|curry|taco|tacos|potato|potatoes|veggie|veggies|vegetable|vegetables|mushroom|mushrooms|cauliflower|broccoli|zucchini|avocado|egg|eggs|bread|muffin|muffins|waffle|waffles|pancake|pancakes|lentil|lentils|chickpea|chickpeas|bean|beans|quinoa|oats|banana|smoothie|cookie|cookies|cake|pie|sauce|copycat|casserole|skillet|roasted|grilled|baked|fried|slow cooker|air fryer|garlic|butter|cheese|cheesy|stuffed|marinade|meatball|meatballs|chili|pizza|lasagna|cabbage|cups|wraps|sandwich|burgers?|dessert|brownies?)\b/i;

const INSTRUCTION_START_RE =
  /^(optional:?\s*)?(add|mix|stir|cook|bake|heat|pour|spread|roast|broil|serve|finish|combine|whisk|drizzle|garnish|assemble|marinate|marinade|preheat|place|arrange|layer|toss|slice|chop|season|top|remove|transfer|fold|cover|simmer|boil|grill|fry|build|melt|saut(?:e|é))\b/i;

const INSTRUCTION_VERB_RE =
  /\b(add|mix|stir|cook|bake|heat|pour|spread|roast|broil|serve|finish|combine|whisk|drizzle|garnish|assemble|marinate|marinade|preheat|place|arrange|layer|toss|season|top|cover|simmer|boil|grill|fry|build|melt|saut(?:e|é))\b/i;

const INSTRUCTION_CONTEXT_RE =
  /\b(minutes?|until|bowl|pan|pot|tray|dish|oven|coated|tender|fragrant|golden|caramelized|halfway|lemon|brightness|sauce|serve|served|seasoning|single layer|above|mixture|skillet|baking dish|air fryer|remaining butter|chowder base|onion|garlic)\b/i;

const MEASUREMENT_TITLE_RE =
  /^(?:\d+(?:\.\d+)?|\d+\/\d+|½|¼|¾|one|two|three|four|five|six)\s*(?:lb|lbs|pound|pounds|oz|ounces?|cups?|tbsp|tablespoons?|tsp|teaspoons?|cloves?|cans?|packages?|sticks?)\b/i;

const GENERIC_RECIPE_CATEGORY_RE =
  /^(?:shrimp|chicken|beef|pork|salmon|fish|seafood|pasta|rice|taco|tacos|soup|salad|dessert|dinner|breakfast|lunch|air fryer|slow cooker|crockpot|keto|healthy|easy|quick|low carb|high protein)\s+recipes?$/i;

function normalizeSpaces(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForCompare(value) {
  return normalizeSpaces(value)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeSimpleEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function detectPlatform(sourceUrl = "") {
  const lowerUrl = String(sourceUrl || "").toLowerCase();

  if (lowerUrl.includes("instagram.com")) return "instagram";
  if (lowerUrl.includes("tiktok.com")) return "tiktok";
  if (lowerUrl.includes("facebook.com") || lowerUrl.includes("fb.watch")) {
    return "facebook";
  }

  return "social";
}

function getFallbackTitle(platform) {
  if (platform === "instagram") return "Instagram Recipe";
  if (platform === "tiktok") return "TikTok Recipe";
  if (platform === "facebook") return "Facebook Recipe";
  return "Saved Social Recipe";
}

function extractAccountName(value) {
  const text = decodeSimpleEntities(value);
  const match = text.match(/^\s*(.+?)\s+on\s+(Instagram|TikTok|Facebook)\s*:/i);

  if (!match?.[1]) return "";

  return normalizeSpaces(match[1].replace(/^[@\s]+/, ""));
}

function removeSocialWrapperPrefix(value) {
  return String(value || "")
    .replace(/^\s*.+?\s+on\s+Instagram\s*:\s*/i, "")
    .replace(/^\s*.+?\s+on\s+TikTok\s*:\s*/i, "")
    .replace(/^\s*.+?\s+on\s+Facebook\s*:\s*/i, "")
    .replace(/^\s*[\d,]+\s+likes?,\s*[\d,]+\s+comments?\s*-\s*[^:]+:\s*/i, "")
    .replace(/^\s*[\d,]+\s+likes?\s*-\s*[^:]+:\s*/i, "")
    .trim();
}

function stripOuterQuotes(value) {
  return String(value || "")
    .trim()
    .replace(/^["'“”]+/, "")
    .replace(/["'“”\.\s]+$/g, "")
    .trim();
}

function extractQuotedCaptions(value) {
  const text = decodeSimpleEntities(value);
  const candidates = [];
  const patterns = [
    /"([\s\S]{4,2000}?)"/g,
    /“([\s\S]{4,2000}?)”/g,
    /'([^']{4,2000}?)'/g,
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      candidates.push(stripOuterQuotes(match[1]));
    }
  }

  return candidates.filter(Boolean);
}

function cleanCaptionText(value) {
  return stripOuterQuotes(
    removeSocialWrapperPrefix(decodeSimpleEntities(value))
      .replace(/\\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function cleanTitleCandidate(value) {
  let text = cleanCaptionText(value);

  text = text
    .split(/ingredients?:|instructions?:|directions?:|method:|steps:|macros?:|nutrition:|serving ideas/i)[0]
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/#[A-Za-z0-9_-]+/g, " ")
    .replace(/@\w+/g, " ")
    .replace(/\bfull recipe\b.*$/i, " ")
    .replace(/\bfull details\b.*$/i, " ")
    .replace(/\bstep by step\b.*$/i, " ")
    .replace(/\bon my page\b.*$/i, " ")
    .replace(/\bright under my profile picture\b.*$/i, " ")
    .replace(/\bunder my profile picture\b.*$/i, " ")
    .replace(/\brecipe below\b.*$/i, " ")
    .replace(/\brecipe in caption\b.*$/i, " ")
    .replace(/\blink in bio\b.*$/i, " ")
    .replace(/\bcomment for\b.*$/i, " ")
    .replace(/\bfollow for\b.*$/i, " ")
    .replace(/^recipe\s*[:\-]\s*/i, "")
    .replace(/^title\s*[:\-]\s*/i, "")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .replace(/[★✦✨⭐️✅📌📝🍽️🥩🍚👩‍🍳⬆️]/g, " ")
    .replace(/^[^\w]+/g, "")
    .replace(/[^\w\s&'’/-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

function titleCaseWords(value) {
  return normalizeSpaces(value)
    .split(" ")
    .map((word) => {
      if (!word) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ")
    .trim();
}

function humanizeHashtag(tag) {
  const raw = String(tag || "")
    .replace(/^#/, "")
    .replace(/[_-]+/g, " ")
    .trim();

  if (!raw) return "";

  const spaced = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/(veggies|vegetables|shrimp|prawns|chicken|beef|salmon|pasta|rice|tacos|potatoes|mushrooms|cabbage|cups|skillet|casserole|soup|salad|pizza|garlic|butter|roasted|grilled|baked|stuffed)/gi, " $1 ")
    .replace(/\s+/g, " ")
    .trim();

  return titleCaseWords(spaced);
}

function scoreHashtagTitleCandidate(value) {
  const text = normalizeSpaces(value).toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  let score = 0;

  if (words.length >= 2 && words.length <= 5) score += 3;
  if (FOOD_TITLE_WORDS.test(text)) score += 5;
  if (/\b(roasted|grilled|baked|stuffed|garlic|butter|cheesy|slow cooker|air fryer)\b/i.test(text)) {
    score += 3;
  }
  if (/\b(recipe|recipes|food|foods|foodie|foodinspo|eating|healthy|comfortfood|yummy|yum)\b/i.test(text)) {
    score -= 5;
  }
  if (words.length > 6) score -= 4;

  return score;
}

function extractHashtagTitleCandidates(value) {
  const tags = String(value || "").match(/#[A-Za-z0-9_-]+/g) || [];

  return tags
    .map(humanizeHashtag)
    .filter(Boolean)
    .filter((candidate) => FOOD_TITLE_WORDS.test(candidate))
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreHashtagTitleCandidate(candidate),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((item) => item.candidate);
}


function extractTitleCandidatesFromCaption(value) {
  const caption = cleanCaptionText(value);

  if (!caption) return [];

  const beforeSections = caption
    .split(/ingredients?:|instructions?:|directions?:|method:|steps:|macros?:|nutrition:|serving ideas/i)[0]
    .trim();

  const pieces = [
    beforeSections,
    ...beforeSections.split(/\n|\r|\||•|◆|✦|⭐|📝|👩‍🍳|🥩|🍚/),
  ];

  return pieces
    .flatMap((piece) => piece.split(/(?<=[.!?])\s+/))
    .map(cleanTitleCandidate)
    .filter(Boolean);
}

function isBadTitleCandidate(value, accountName = "") {
  const text = normalizeSpaces(value).normalize("NFC").toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  if (!text) return true;
  if (text.length < 4) return true;
  if (text.length > 90) return true;
  if (words.length > 12) return true;

  if (accountName && normalizeForCompare(text) === normalizeForCompare(accountName)) {
    return true;
  }

  const genericSocialTitle =
    text === "instagram" ||
    text === "instagram recipe" ||
    text === "tiktok" ||
    text === "tiktok recipe" ||
    text === "facebook" ||
    text === "facebook recipe" ||
    text.includes(" on instagram") ||
    text.includes(" on tiktok") ||
    text.includes(" on facebook") ||
    text.includes("tiktok - make your day") ||
    text.includes("make your day") ||
    text.includes("photos and videos") ||
    text.includes("watch more") ||
    text.includes("log in") ||
    text.includes("sign up");

  const sectionOrMetaText =
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
    text.includes("carbs") ||
    text.includes("fat:") ||
    text.includes("time:") ||
    text.includes("serving:");

  const promotionalNoise =
    text.includes("follow for") ||
    text.includes("comment") ||
    text.includes("save this") ||
    text.includes("share this") ||
    text.includes("link in bio") ||
    text.includes("check out") ||
    text.includes("take a look") ||
    text.includes("profile picture");

  const startsLikeInstruction = INSTRUCTION_START_RE.test(text);
  const containsInstructionPhrase =
    INSTRUCTION_VERB_RE.test(text) && INSTRUCTION_CONTEXT_RE.test(text);

    const hasColonInstruction =
  /:\s*(in|add|mix|stir|melt|cook|bake|heat|pour|spread|combine|whisk|place|arrange|toss|season|build)\b/i.test(
    text
  );

  const likelyAccountOnlyTitle =
    words.length <= 3 && !FOOD_TITLE_WORDS.test(text) && /kitchen|recipes?|food|macro/i.test(text);

    const startsWithMeasurement = MEASUREMENT_TITLE_RE.test(text);

const genericRecipeCategory = GENERIC_RECIPE_CATEGORY_RE.test(text);

  return (
  genericSocialTitle ||
  likelyAccountOnlyTitle ||
  startsWithMeasurement ||
  genericRecipeCategory ||
  sectionOrMetaText ||
  promotionalNoise ||
  startsLikeInstruction ||
  containsInstructionPhrase ||
  hasColonInstruction
);
}

function scoreTitleCandidate(value) {
  const text = normalizeSpaces(value).toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  let score = 0;

  if (words.length >= 2 && words.length <= 8) score += 4;
  if (words.length >= 9 && words.length <= 12) score += 1;
  if (FOOD_TITLE_WORDS.test(text)) score += 5;
  if (text.includes("recipe")) score += 1;
  if (text.length > 70) score -= 2;
  if (INSTRUCTION_VERB_RE.test(text)) score -= 2;

  return score;
}

function chooseBestCaption(candidates) {
  const cleaned = Array.from(
    new Set(candidates.map(cleanCaptionText).filter(Boolean))
  );

  if (cleaned.length === 0) return "";

  return cleaned
    .map((caption, index) => {
      const lower = caption.toLowerCase();
      let score = 0;

      if (FOOD_TITLE_WORDS.test(caption)) score += 2;
      if (/ingredients?:|instructions?:|directions?:|steps?:|you need|what you need/i.test(caption)) {
        score += 6;
      }
      if (caption.length > 80) score += 2;
      if (caption.length > 400) score += 1;
      if (lower.includes("log in") || lower.includes("sign up")) score -= 10;

      return { caption, index, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })[0].caption;
}

function chooseBestTitle(candidates, accountName = "") {
  const cleaned = Array.from(
    new Set(candidates.map(cleanTitleCandidate).filter(Boolean))
  );

  const goodCandidates = cleaned.filter(
    (candidate) => !isBadTitleCandidate(candidate, accountName)
  );

  if (goodCandidates.length === 0) return "";

  return goodCandidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreTitleCandidate(candidate),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })[0].candidate;
}

function compactRescueParts(parts) {
  const results = [];
  const seen = new Set();

  for (const part of parts) {
    const cleaned = cleanCaptionText(part);

    if (!cleaned) continue;

    const key = normalizeForCompare(cleaned);

    if (!key || seen.has(key)) continue;

    const alreadyCovered = results.some((existing) => {
      const existingKey = normalizeForCompare(existing);

      if (!existingKey) return false;

      return (
        (key.length > 40 && existingKey.includes(key)) ||
        (existingKey.length > 40 && key.includes(existingKey))
      );
    });

    if (alreadyCovered) continue;

    results.push(cleaned);
    seen.add(key);
  }

  return results;
}


export function resolveSocialCaptionParts({
  rawName = "",
  description = "",
  fallbackText = "",
  sourceUrl = "",
} = {}) {
  const platform = detectPlatform(sourceUrl);
  const fallbackTitle = getFallbackTitle(platform);

  const accountName =
    extractAccountName(rawName) || extractAccountName(description) || "";

  const quotedCaptions = [
    ...extractQuotedCaptions(rawName),
    ...extractQuotedCaptions(description),
    ...extractQuotedCaptions(fallbackText),
  ];

  const unwrappedCandidates = [
    cleanCaptionText(rawName),
    cleanCaptionText(description),
    cleanCaptionText(fallbackText),
  ].filter(Boolean);

  const rawCaption = chooseBestCaption([...quotedCaptions, ...unwrappedCandidates]);

  const hashtagTitleCandidates = extractHashtagTitleCandidates([
    rawCaption,
    description,
    rawName,
    fallbackText,
  ].join("\n\n"));

  const titleCandidates = [
    ...extractTitleCandidatesFromCaption(rawCaption),
    ...extractTitleCandidatesFromCaption(rawName),
    ...extractTitleCandidatesFromCaption(description),
    ...quotedCaptions.map(cleanTitleCandidate),
    ...hashtagTitleCandidates,
  ].filter(Boolean);

  const titleCandidate = chooseBestTitle(titleCandidates, accountName);

  const rescueParts = compactRescueParts([
    rawCaption,
    description,
    rawName,
    fallbackText,
    sourceUrl,
  ]);

  return {
    platform,
    fallbackTitle,
    accountName,
    rawCaption,
    titleCandidate,
    rescueText: rescueParts.join("\n\n"),
    titleCandidates: Array.from(new Set(titleCandidates)).slice(0, 8),
  };
}

export function chooseSocialRecipeTitle({
  rawName = "",
  description = "",
  fallbackText = "",
  sourceUrl = "",
} = {}) {
  const parts = resolveSocialCaptionParts({
    rawName,
    description,
    fallbackText,
    sourceUrl,
  });

  return parts.titleCandidate || parts.fallbackTitle;
}
