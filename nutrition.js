// =====================================================
// Simple Dinners nutrition analysis
//
// OpenAI:
//   - parses recipe ingredient language only
//
// USDA FoodData Central:
//   - identifies foods
//   - supplies portion weights
//   - supplies nutrient values
//
// Nutrition values are never invented by AI.
// =====================================================

const USDA_BASE =
  "https://api.nal.usda.gov/fdc/v1";

const GRAMS_PER_OUNCE = 28.349523125;
const GRAMS_PER_POUND = 453.59237;

const SEARCH_CACHE_LIMIT = 500;
const DETAIL_CACHE_LIMIT = 500;
const RESULT_CACHE_LIMIT = 200;

const searchCache = new Map();
const detailCache = new Map();
const resultCache = new Map();

function setLimitedCache(
  cache,
  key,
  value,
  limit,
) {
  if (cache.has(key)) {
    cache.delete(key);
  }

  cache.set(key, value);

  while (cache.size > limit) {
    const oldestKey =
      cache.keys().next().value;

    cache.delete(oldestKey);
  }
}

function stripJsonCodeFence(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJsonResponse(value) {
  const cleaned =
    stripJsonCodeFence(value);

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace =
      cleaned.indexOf("{");

    const lastBrace =
      cleaned.lastIndexOf("}");

    if (
      firstBrace >= 0 &&
      lastBrace > firstBrace
    ) {
      return JSON.parse(
        cleaned.slice(
          firstBrace,
          lastBrace + 1,
        ),
      );
    }

    throw new Error(
      "Ingredient parser did not return valid JSON.",
    );
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeUsdaSearchQuery(
  value,
) {
  return String(value || "")
    .trim()
    .replace(
      /(\d)\s*\/\s*(\d)/g,
      "$1 $2",
    )
    .replace(/\s+/g, " ");
}

function normalizeUnit(value) {
  const normalized =
    normalizeText(value);

  const aliases = {
    g: "gram",
    gram: "gram",
    grams: "gram",

    kg: "kilogram",
    kilogram: "kilogram",
    kilograms: "kilogram",

    oz: "ounce",
    ounce: "ounce",
    ounces: "ounce",

    lb: "pound",
    lbs: "pound",
    pound: "pound",
    pounds: "pound",

    ml: "milliliter",
    milliliter: "milliliter",
    milliliters: "milliliter",

    l: "liter",
    liter: "liter",
    liters: "liter",

    tsp: "teaspoon",
    teaspoon: "teaspoon",
    teaspoons: "teaspoon",

    tbsp: "tablespoon",
    tbs: "tablespoon",
    tablespoon: "tablespoon",
    tablespoons: "tablespoon",

    c: "cup",
    cup: "cup",
    cups: "cup",

    clove: "clove",
    cloves: "clove",

    slice: "slice",
    slices: "slice",

    piece: "piece",
    pieces: "piece",

    can: "can",
    cans: "can",

    package: "package",
    packages: "package",

    packet: "packet",
    packets: "packet",

    jar: "jar",
    jars: "jar",

    bottle: "bottle",
    bottles: "bottle",

    carton: "carton",
    cartons: "carton",

    large: "large",
    medium: "medium",
    small: "small",
  };

  return aliases[normalized] ||
    normalized;
}

function directMassToGrams(
  quantity,
  unit,
) {
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return null;
  }

  switch (normalizeUnit(unit)) {
    case "gram":
      return quantity;

    case "kilogram":
      return quantity * 1000;

    case "ounce":
      return (
        quantity *
        GRAMS_PER_OUNCE
      );

    case "pound":
      return (
        quantity *
        GRAMS_PER_POUND
      );

    default:
      return null;
  }
}

function packageSizeToGrams(
  ingredient,
) {
  const quantity =
    Number(ingredient.quantity);

  const packageQuantity =
    Number(
      ingredient.packageSizeQuantity,
    );

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(packageQuantity) ||
    packageQuantity <= 0
  ) {
    return null;
  }

  const gramsPerPackage =
    directMassToGrams(
      packageQuantity,
      ingredient.packageSizeUnit,
    );

  if (!gramsPerPackage) {
    return null;
  }

  return (
    quantity *
    gramsPerPackage
  );
}

function buildPortionText(portion) {
  return normalizeText(
    [
      portion?.measureUnit?.name,
      portion?.measureUnit
        ?.abbreviation,
      portion?.modifier,
      portion?.portionDescription,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function portionUnitTerms(
  ingredientUnit,
) {
  const unit =
    normalizeUnit(ingredientUnit);

  const aliases = {
    teaspoon: [
      "teaspoon",
      "tsp",
    ],
    tablespoon: [
      "tablespoon",
      "tbsp",
      "tbs",
    ],
    cup: [
      "cup",
    ],
    milliliter: [
      "milliliter",
      "ml",
    ],
    liter: [
      "liter",
    ],
    clove: [
      "clove",
    ],
    slice: [
      "slice",
    ],
    piece: [
      "piece",
    ],
    can: [
      "can",
    ],
    package: [
      "package",
    ],
    packet: [
      "packet",
    ],
    jar: [
      "jar",
    ],
    bottle: [
      "bottle",
    ],
    carton: [
      "carton",
    ],
    large: [
      "large",
    ],
    medium: [
      "medium",
    ],
    small: [
      "small",
    ],
  };

  return aliases[unit] ||
    (unit ? [unit] : []);
}

function portionMatchScore(
  portion,
  ingredientUnit,
) {
  const terms =
    portionUnitTerms(
      ingredientUnit,
    );
  if (!terms.length) {
    return 0;
  }

  const text =
    buildPortionText(portion);
  if (!text) {
    return 0;
  }

  const directPortionFields = [
    portion?.measureUnit?.name,
    portion?.measureUnit
      ?.abbreviation,
    portion?.modifier,
    portion?.portionDescription,
  ]
    .filter(Boolean)
    .map((value) =>
      normalizeText(value),
    );

  // Prefer an exact USDA portion field such as
  // modifier: "large" over a different portion that merely
  // mentions the word, such as "cup (4.86 large eggs)".
  for (const term of terms) {
    const normalizedTerm =
      normalizeText(term);

    if (
      normalizedTerm &&
      directPortionFields.includes(
        normalizedTerm,
      )
    ) {
      return 125;
    }
  }

  // Prefer a portion field that begins with the requested
  // size/unit over one that merely mentions it later.
  //
  // Example:
  // "medium (2-1/2\" dia)" should outrank
  // "slice, medium (1/8\" thick)" for "1 medium onion".
  for (const term of terms) {
    const normalizedTerm =
      normalizeText(term);

    if (
      normalizedTerm &&
      directPortionFields.some(
        (field) =>
          field.startsWith(
            `${normalizedTerm} `,
          ) ||
          field.startsWith(
            `${normalizedTerm},`,
          ),
      )
    ) {
      return 115;
    }
  }

  const normalizedText =
    ` ${text} `;

  for (const term of terms) {
    const normalizedTerm =
      normalizeText(term);
    if (
      normalizedTerm &&
      normalizedText.includes(
        ` ${normalizedTerm} `,
      )
    ) {
      return 100;
    }
  }

  for (const term of terms) {
    const normalizedTerm =
      normalizeText(term);
    if (
      normalizedTerm &&
      text.includes(
        normalizedTerm,
      )
    ) {
      return 75;
    }
  }

  return 0;
}

function portionContextAdjustment(
  portion,
  ingredient,
) {
  const portionText =
    buildPortionText(portion);

  const ingredientText =
    normalizeText(
      [
        ingredient?.original,
        ingredient?.food,
      ]
        .filter(Boolean)
        .join(" "),
    );

  let adjustment = 0;

  // Do not use a whipped measurement for fluid cream
  // unless the recipe actually calls for whipped cream.
  if (
    portionText.includes("whipped") &&
    !ingredientText.includes("whipped")
  ) {
    adjustment -= 100;
  }

  if (
    portionText.includes("fluid") &&
    !ingredientText.includes("whipped")
  ) {
    adjustment += 30;
  }

  // Dry/raw ingredients should not use cooked household portions.
  if (
    (
      ingredientText.includes(" dry ") ||
      ingredientText.startsWith("dry ") ||
      ingredientText.includes(" uncooked ")
    ) &&
    /\bcooked\b/.test(portionText)
  ) {
    adjustment -= 100;
  }

  if (
    (
      ingredientText.includes(" fresh ") ||
      ingredientText.startsWith("fresh ") ||
      ingredientText.includes(" raw ")
    ) &&
    /\bcooked\b/.test(portionText)
  ) {
    adjustment -= 100;
  }

  // Pasta cup weights vary substantially by shape.
  // Never silently use shells, elbows, penne, etc. for orzo.
  const pastaShapes = [
    "orzo",
    "shell",
    "shells",
    "rotini",
    "elbow",
    "elbows",
    "spaghetti",
    "penne",
    "farfalle",
    "lasagna",
    "macaroni",
  ];

  const ingredientShape =
    pastaShapes.find(
      (shape) =>
        ingredientText.includes(shape),
    );

  const portionShape =
    pastaShapes.find(
      (shape) =>
        portionText.includes(shape),
    );

  if (
    ingredientShape &&
    portionShape &&
    ingredientShape !== portionShape
  ) {
    adjustment -= 200;
  }

  if (
    ingredientShape &&
    portionShape === ingredientShape
  ) {
    adjustment += 50;
  }

  return adjustment;
}

function volumeUnitToTablespoons(
  unit,
) {
  switch (normalizeUnit(unit)) {
    case "cup":
      return 16;

    case "tablespoon":
      return 1;

    case "teaspoon":
      return 1 / 3;

    default:
      return null;
  }
}

function portionVolumeUnit(
  portion,
) {
  const text =
    buildPortionText(portion);

  if (
    /\b(table spoon|tablespoon|tbsp|tbs)\b/.test(
      text,
    )
  ) {
    return "tablespoon";
  }

  if (
    /\b(tea spoon|teaspoon|tsp)\b/.test(
      text,
    )
  ) {
    return "teaspoon";
  }

  if (/\bcup\b/.test(text)) {
    return "cup";
  }

  return null;
}

function equivalentVolumeToGrams(
  portion,
  ingredient,
) {
  const ingredientQuantity =
    Number(ingredient?.quantity);

  const gramWeight =
    Number(portion?.gramWeight);

  const portionAmount =
    Number(portion?.amount || 1);

  if (
    !Number.isFinite(
      ingredientQuantity,
    ) ||
    ingredientQuantity <= 0 ||
    !Number.isFinite(gramWeight) ||
    gramWeight <= 0 ||
    !Number.isFinite(
      portionAmount,
    ) ||
    portionAmount <= 0
  ) {
    return null;
  }

  const ingredientVolume =
    volumeUnitToTablespoons(
      ingredient?.unit,
    );

  const portionUnit =
    portionVolumeUnit(portion);

  const portionVolume =
    volumeUnitToTablespoons(
      portionUnit,
    );

  if (
    !ingredientVolume ||
    !portionVolume
  ) {
    return null;
  }

  const ingredientTablespoons =
    ingredientQuantity *
    ingredientVolume;

  const tablespoonsPerPortion =
    portionAmount *
    portionVolume;

  return (
    (
      ingredientTablespoons /
      tablespoonsPerPortion
    ) *
    gramWeight
  );
}

function portionToGrams(
  food,
  ingredient,
) {
  const quantity =
    Number(ingredient.quantity);

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return null;
  }

  const portions =
    Array.isArray(food?.foodPortions)
      ? food.foodPortions
      : [];

  let best = null;

  for (const portion of portions) {
    const gramWeight =
      Number(portion?.gramWeight);

    const portionAmount =
      Number(portion?.amount || 1);

    if (
      !Number.isFinite(gramWeight) ||
      gramWeight <= 0 ||
      !Number.isFinite(portionAmount) ||
      portionAmount <= 0
    ) {
      continue;
    }

    const unitScore =
      portionMatchScore(
        portion,
        ingredient.unit,
      );

    if (unitScore <= 0) {
      continue;
    }

    const score =
      unitScore +
      portionContextAdjustment(
        portion,
        ingredient,
      );

    if (
      score > 0 &&
      (!best || score > best.score)
    ) {
      best = {
        score,
        gramWeight,
        portionAmount,
        portion,
      };
    }
  }

  if (best) {
    return (
      quantity *
      (
        best.gramWeight /
        best.portionAmount
      )
    );
  }

  let bestEquivalent = null;

  for (const portion of portions) {
    const grams =
      equivalentVolumeToGrams(
        portion,
        ingredient,
      );

    if (
      !Number.isFinite(grams) ||
      grams <= 0
    ) {
      continue;
    }

    const contextScore =
      portionContextAdjustment(
        portion,
        ingredient,
      );

    if (contextScore <= -100) {
      continue;
    }

    const score =
      50 + contextScore;

    if (
      !bestEquivalent ||
      score >
        bestEquivalent.score
    ) {
      bestEquivalent = {
        score,
        grams,
      };
    }
  }

  return bestEquivalent
    ? bestEquivalent.grams
    : null;
}

function parseHouseholdNumber(
  value,
) {
  const text =
    String(value || "").trim();

  const mixed =
    text.match(
      /^(\d+)\s+(\d+)\/(\d+)$/,
    );

  if (mixed) {
    const whole =
      Number(mixed[1]);

    const numerator =
      Number(mixed[2]);

    const denominator =
      Number(mixed[3]);

    if (
      denominator > 0
    ) {
      return (
        whole +
        numerator / denominator
      );
    }
  }

  const fraction =
    text.match(
      /^(\d+)\/(\d+)$/,
    );

  if (fraction) {
    const numerator =
      Number(fraction[1]);

    const denominator =
      Number(fraction[2]);

    if (
      denominator > 0
    ) {
      return (
        numerator /
        denominator
      );
    }
  }

  const numeric =
    Number(text);

  return Number.isFinite(numeric)
    ? numeric
    : null;
}

function brandedHouseholdServingToGrams(
  food,
  ingredient,
) {
  const servingSize =
    Number(food?.servingSize);

  const servingUnit =
    normalizeText(
      food?.servingSizeUnit,
    );

  if (
    !Number.isFinite(servingSize) ||
    servingSize <= 0 ||
    ![
      "g",
      "gram",
      "grams",
      "grm",
    ].includes(servingUnit)
  ) {
    return null;
  }

  const household =
    String(
      food?.householdServingFullText ||
      "",
    ).trim();

  const match =
    household.match(
      /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*(cups?|tablespoons?|tbsp|tbs|teaspoons?|tsp)\b/i,
    );

  if (!match) {
    return null;
  }

  const householdQuantity =
    parseHouseholdNumber(
      match[1],
    );

  const householdUnit =
    normalizeUnit(
      match[2],
    );

  const householdVolume =
    volumeUnitToTablespoons(
      householdUnit,
    );

  const ingredientVolume =
    volumeUnitToTablespoons(
      ingredient?.unit,
    );

  const ingredientQuantity =
    Number(
      ingredient?.quantity,
    );

  if (
    !householdQuantity ||
    !householdVolume ||
    !ingredientVolume ||
    !Number.isFinite(
      ingredientQuantity,
    ) ||
    ingredientQuantity <= 0
  ) {
    return null;
  }

  const servingTablespoons =
    householdQuantity *
    householdVolume;

  const ingredientTablespoons =
    ingredientQuantity *
    ingredientVolume;

  return (
    servingSize *
    (
      ingredientTablespoons /
      servingTablespoons
    )
  );
}

function normalizeCountUnit(
  value,
) {
  const text =
    normalizeText(value);

  if (
    text.includes("tortilla")
  ) {
    return "tortilla";
  }

  if (
    text.includes("slice")
  ) {
    return "slice";
  }

  if (
    text.includes("chip")
  ) {
    return "chip";
  }

  if (
    text.includes("piece")
  ) {
    return "piece";
  }

  return null;
}

function ingredientCountUnit(
  ingredient,
) {
  return (
    normalizeCountUnit(
      ingredient?.unit,
    ) ||
    normalizeCountUnit(
      ingredient?.food,
    ) ||
    normalizeCountUnit(
      ingredient?.original,
    )
  );
}

function countUnitsCompatible(
  requested,
  household,
  ingredient,
) {
  if (
    requested === household
  ) {
    return true;
  }

  const ingredientText =
    normalizeText(
      [
        ingredient?.original,
        ingredient?.food,
      ]
        .filter(Boolean)
        .join(" "),
    );

  // Pickle chips are also commonly labeled slices or pieces
  // in USDA branded serving descriptions.
  if (
    ingredientText.includes("pickle")
  ) {
    const pickleUnits =
      new Set([
        "chip",
        "slice",
        "piece",
      ]);

    return (
      pickleUnits.has(requested) &&
      pickleUnits.has(household)
    );
  }

  return false;
}

function brandedCountServingToGrams(
  food,
  ingredient,
) {
  const servingSize =
    Number(food?.servingSize);

  const servingUnit =
    normalizeText(
      food?.servingSizeUnit,
    );

  if (
    !Number.isFinite(servingSize) ||
    servingSize <= 0 ||
    ![
      "g",
      "gram",
      "grams",
      "grm",
    ].includes(servingUnit)
  ) {
    return null;
  }

  const household =
    String(
      food?.householdServingFullText ||
      "",
    ).trim();

  if (!household) {
    return null;
  }

  const match =
    household.match(
      /(?:about\s+)?(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s+(?:[a-z]\s+)?(tortillas?|slices?|chips?|pieces?)\b/i,
    );

  if (!match) {
    return null;
  }

  const householdQuantity =
    parseHouseholdNumber(
      match[1],
    );

  const householdUnit =
    normalizeCountUnit(
      match[2],
    );

  const requestedUnit =
    ingredientCountUnit(
      ingredient,
    );

  const ingredientQuantity =
    Number(
      ingredient?.quantity,
    );

  if (
    !householdQuantity ||
    householdQuantity <= 0 ||
    !householdUnit ||
    !requestedUnit ||
    !Number.isFinite(
      ingredientQuantity,
    ) ||
    ingredientQuantity <= 0 ||
    !countUnitsCompatible(
      requestedUnit,
      householdUnit,
      ingredient,
    )
  ) {
    return null;
  }

  return (
    servingSize *
    (
      ingredientQuantity /
      householdQuantity
    )
  );
}

function ingredientToGrams(
  food,
  ingredient,
) {
  const packageGrams =
    packageSizeToGrams(ingredient);

  if (packageGrams) {
    return {
      grams: packageGrams,
      method: "package-weight",
    };
  }

  const directGrams =
    directMassToGrams(
      Number(ingredient.quantity),
      ingredient.unit,
    );

  if (directGrams) {
    return {
      grams: directGrams,
      method: "direct-weight",
    };
  }

  const portionGrams =
    portionToGrams(
      food,
      ingredient,
    );

  if (portionGrams) {
    return {
      grams: portionGrams,
      method: "usda-portion",
    };
  }

  const brandedHouseholdGrams =
    brandedHouseholdServingToGrams(
      food,
      ingredient,
    );

  if (brandedHouseholdGrams) {
    return {
      grams:
        brandedHouseholdGrams,
      method:
        "usda-branded-household",
    };
  }

  const brandedCountGrams =
    brandedCountServingToGrams(
      food,
      ingredient,
    );

  if (brandedCountGrams) {
    return {
      grams:
        brandedCountGrams,
      method:
        "usda-branded-count",
    };
  }

  return null;
}

function isBrandRequested(
  ingredient,
) {
  return Boolean(
    String(
      ingredient?.brand || "",
    ).trim(),
  );
}

function candidateContextAdjustment(
  candidate,
  ingredient,
) {
  const description =
    normalizeText(
      candidate?.description,
    );

  const ingredientText =
    normalizeText(
      [
        ingredient?.original,
        ingredient?.food,
      ]
        .filter(Boolean)
        .join(" "),
    );

  let adjustment = 0;

  const wantsRedPepperFlakes =
    ingredientText.includes(
      "red pepper flakes",
    ) ||
    ingredientText.includes(
      "red pepper flake",
    ) ||
    ingredientText.includes(
      "crushed red pepper",
    );

  if (wantsRedPepperFlakes) {
    if (
      description.includes("spice") &&
      description.includes("pepper") &&
      (
        description.includes("red") ||
        description.includes("cayenne")
      )
    ) {
      adjustment += 220;
    }

    if (
      description.includes("sweet") ||
      description.includes("bell") ||
      /\bcooked\b/.test(description) ||
      description.includes("sauteed") ||
      description.includes("raw")
    ) {
      adjustment -= 220;
    }
  }

  // Avoid specialty/prepared variants unless the
  // recipe actually asks for them.
  const variantTerms = [
    "gluten free",
    "chickpea",
    "lentil",
    "whole wheat",
    "whole grain",
    "carb counter",
    "low carb",
    "keto",
    "imitation",
    "substitute",
  ];

  for (const term of variantTerms) {
    if (
      description.includes(term) &&
      !ingredientText.includes(term)
    ) {
      adjustment -= 180;
    }
  }

  const preparedDishTerms = [
    "salad",
    "soup",
    "casserole",
    "pilaf",
    "bake",
  ];

  for (const term of preparedDishTerms) {
    if (
      description.includes(term) &&
      !ingredientText.includes(term)
    ) {
      adjustment -= 220;
    }
  }

  const wantsPickleChips =
    ingredientText.includes(
      "pickle chip",
    ) ||
    ingredientText.includes(
      "pickle slice",
    );

  if (wantsPickleChips) {
    const unrelatedPickleProducts = [
      "potato",
      "kale",
      "cashew",
      "hummus",
      "mustard",
      "popcorn",
    ];

    for (
      const term
      of unrelatedPickleProducts
    ) {
      if (
        description.includes(term) &&
        !ingredientText.includes(term)
      ) {
        adjustment -= 250;
      }
    }
  }

  const wantsFreshOrRaw =
    ingredientText.includes("fresh") ||
    ingredientText.includes("raw");

  if (wantsFreshOrRaw) {
    if (description.includes("raw")) {
      adjustment += 35;
    }

    if (
      /\bcooked\b/.test(description) ||
      description.includes("frozen") ||
      description.includes("canned")
    ) {
      adjustment -= 120;
    }

    if (
      description.includes("with oil") ||
      description.includes("in oil")
    ) {
      adjustment -= 80;
    }
  }

  const wantsDry =
    ingredientText.includes("dry") ||
    ingredientText.includes("uncooked");

  if (
    wantsDry &&
    /\bcooked\b/.test(description)
  ) {
    adjustment -= 120;
  }

  const wantsOilPacked =
    ingredientText.includes("oil packed") ||
    ingredientText.includes("packed in oil");

  if (
    wantsOilPacked &&
    (
      description.includes("packed in oil") ||
      description.includes("with oil")
    )
  ) {
    adjustment += 40;
  }

  return adjustment;
}

const FOOD_IDENTITY_IGNORED_TOKENS =
  new Set([
    "fresh",
    "freshly",
    "baby",
    "boneless",
    "skinless",
    "dry",
    "raw",
    "drained",
    "chopped",
    "minced",
    "diced",
    "sliced",
    "grated",
    "shredded",
    "cut",
    "bite",
    "sized",
    "piece",
    "pieces",
    "low",
    "sodium",
    "packed",
    "optional",
    "to",
    "taste",
    "nfs",
  ]);

function normalizeIdentityToken(
  token,
) {
  let value =
    String(token || "");

  if (
    value.endsWith("ies") &&
    value.length > 4
  ) {
    return (
      value.slice(0, -3) +
      "y"
    );
  }

  if (
    value.endsWith("oes") &&
    value.length > 4
  ) {
    return value.slice(0, -2);
  }

  if (
    value.endsWith("s") &&
    value.length > 3 &&
    !value.endsWith("ss") &&
    !value.endsWith("us")
  ) {
    value =
      value.slice(0, -1);
  }

  return value;
}

function foodIdentityTokens(
  value,
) {
  return normalizeText(value)
    .split(" ")
    .map(normalizeIdentityToken)
    .filter(
      (token) =>
        token &&
        !FOOD_IDENTITY_IGNORED_TOKENS.has(
          token,
        ),
    );
}

function foodIdentityCompatibility(
  candidate,
  ingredient,
) {
  const ingredientSource =
    String(
      ingredient?.food ||
      ingredient?.original ||
      "",
    );

  const ingredientTokens =
    Array.from(
      new Set(
        foodIdentityTokens(
          ingredientSource,
        ),
      ),
    );

  const candidateTokens =
    new Set(
      foodIdentityTokens(
        candidate?.description,
      ),
    );

  if (!ingredientTokens.length) {
    return {
      compatible: true,
      overlap: 0,
      required: 0,
    };
  }

  const overlap =
    ingredientTokens.filter(
      (token) =>
        candidateTokens.has(token),
    ).length;

  const required =
    ingredientTokens.length >= 2
      ? 2
      : 1;

  const ingredientDescription =
    normalizeText(
      ingredientSource,
    );

  const candidateDescription =
    normalizeText(
      candidate?.description,
    );

  // Broth / stock is a semantic requirement, not just a
  // shared word. A USDA record such as "chicken, canned,
  // no broth" must never satisfy a request for chicken broth.
  const wantsBrothOrStock =
    ingredientDescription.includes(
      "broth",
    ) ||
    ingredientDescription.includes(
      "stock",
    );

  if (wantsBrothOrStock) {
    const candidateHasBrothOrStock =
      candidateDescription.includes(
        "broth",
      ) ||
      candidateDescription.includes(
        "stock",
      );

    const explicitlyHasNoBroth =
      candidateDescription.includes(
        "no broth",
      ) ||
      candidateDescription.includes(
        "without broth",
      );

    if (
      !candidateHasBrothOrStock ||
      explicitlyHasNoBroth
    ) {
      return {
        compatible: false,
        overlap,
        required,
      };
    }
  }

  const wantsSlices =
    normalizeUnit(
      ingredient?.unit,
    ) === "slice" ||
    /\bslices?\b/.test(
      ingredientDescription,
    );

  if (
    wantsSlices &&
    candidateDescription.includes(
      "spread",
    )
  ) {
    return {
      compatible: false,
      overlap,
      required,
    };
  }

  return {
    compatible:
      overlap >= required,
    overlap,
    required,
  };
}

function candidateScore(
  candidate,
  ingredient,
  index,
) {
  const dataType =
    String(
      candidate?.dataType || "",
    );

  const genericScores = {
    Foundation: 120,
    "SR Legacy": 115,
    "Survey (FNDDS)": 105,
    Branded: 55,
    Experimental: 35,
  };

  const brandedScores = {
    Branded: 130,
    Foundation: 90,
    "SR Legacy": 85,
    "Survey (FNDDS)": 80,
    Experimental: 30,
  };

  const scores =
    isBrandRequested(ingredient)
      ? brandedScores
      : genericScores;

  let score =
    scores[dataType] ?? 50;

  score -= index * 2;

  const description =
    normalizeText(
      candidate?.description,
    );

  const food =
    normalizeText(
      ingredient?.food,
    );

  if (
    description &&
    food
  ) {
    const requestedIdentityTokens =
      foodIdentityTokens(food);

    const candidateIdentityTokens =
      foodIdentityTokens(
        description,
      );

    const requestedIdentitySet =
      new Set(
        requestedIdentityTokens,
      );

    const candidateIdentitySet =
      new Set(
        candidateIdentityTokens,
      );

    const exactIdentityTokenSet =
      requestedIdentitySet.size > 0 &&
      requestedIdentitySet.size ===
        candidateIdentitySet.size &&
      Array.from(
        requestedIdentitySet,
      ).every(
        (token) =>
          candidateIdentitySet.has(
            token,
          ),
      );

    const isSimpleFood =
      requestedIdentityTokens.length === 1;

    const requestedToken =
      requestedIdentityTokens[0] || "";

    const candidateStartsWithFood =
      isSimpleFood &&
      candidateIdentityTokens[0] ===
        requestedToken;

    const candidateContainsFoodToken =
      isSimpleFood &&
      candidateIdentityTokens.includes(
        requestedToken,
      );

    // A basic ingredient such as "egg", "butter", or "salt"
    // should strongly prefer the actual food over a compound
    // product that merely contains the same word.
    //
    // Examples:
    // egg    -> "Egg, whole, raw, fresh"
    //          not "Bagels, egg"
    // butter -> "Butter, salted"
    //          not "Fruit butter"
    if (description === food) {
      score += 260;
    } else if (exactIdentityTokenSet) {
      // USDA often reverses ordinary food-word order.
      // "ground beef" and "Beef, ground" describe the
      // same core food, while "Spanish rice with ground
      // beef" contains additional identity tokens.
      score += 180;
    } else if (candidateStartsWithFood) {
      score += 180;
    } else if (
      description.includes(food)
    ) {
      score += 20;
    }

    if (
      candidateContainsFoodToken &&
      !candidateStartsWithFood
    ) {
      score -= 220;
    }
  }

  const brand =
    normalizeText(
      ingredient?.brand,
    );

  const brandOwner =
    normalizeText(
      candidate?.brandOwner ||
      candidate?.brandName,
    );

  if (
    brand &&
    brandOwner &&
    (
      brandOwner.includes(brand) ||
      brand.includes(brandOwner)
    )
  ) {
    score += 35;
  }

  if (
    !isBrandRequested(ingredient) &&
    (
      description.includes(
        "restaurant",
      ) ||
      description.includes(
        "fast food",
      )
    )
  ) {
    score -= 30;
  }

  score +=
    candidateContextAdjustment(
      candidate,
      ingredient,
    );

  return score;
}

function rankFoodCandidates(
  foods,
  ingredient,
) {
  if (!Array.isArray(foods)) {
    return [];
  }

  return foods
    .map((food, index) => {
      const identity =
        foodIdentityCompatibility(
          food,
          ingredient,
        );

      return {
        food,
        identity,
        score:
          candidateScore(
            food,
            ingredient,
            index,
          ) +
          identity.overlap * 20,
      };
    })
    .filter(
      (candidate) =>
        candidate.identity
          .compatible,
    )
    .sort(
      (a, b) =>
        b.score - a.score,
    );
}

async function searchUsdaFood(
  query,
  apiKey,
  ingredient,
) {
  const normalizedQuery =
    normalizeUsdaSearchQuery(
      query,
    );

  if (!normalizedQuery) {
    return [];
  }

  const branded =
    isBrandRequested(
      ingredient,
    );

  const cacheKey =
    `${branded ? "branded" : "generic"}:${normalizeText(
      normalizedQuery,
    )}`;

  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }

  const url = new URL(
    `${USDA_BASE}/foods/search`,
  );

  url.searchParams.set(
    "api_key",
    apiKey,
  );

  const dataType =
    branded
      ? [
          "Branded",
          "Foundation",
          "SR Legacy",
          "Survey (FNDDS)",
        ]
      : [
          "Foundation",
          "SR Legacy",
          "Survey (FNDDS)",
        ];

  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        query:
          normalizedQuery,
        pageSize: 25,
        dataType,
      }),
    });

  if (!response.ok) {
    throw new Error(
      `USDA food search failed (${response.status}).`,
    );
  }

  const payload =
    await response.json();

  const foods =
    Array.isArray(payload?.foods)
      ? payload.foods
      : [];

  setLimitedCache(
    searchCache,
    cacheKey,
    foods,
    SEARCH_CACHE_LIMIT,
  );

  return foods;
}

async function searchUsdaBrandedFood(
  query,
  apiKey,
) {
  const normalizedQuery =
    normalizeUsdaSearchQuery(
      query,
    );

  if (!normalizedQuery) {
    return [];
  }

  const cacheKey =
    `branded-fallback:${normalizeText(
      normalizedQuery,
    )}`;

  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }

  const url = new URL(
    `${USDA_BASE}/foods/search`,
  );

  url.searchParams.set(
    "api_key",
    apiKey,
  );

  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        query:
          normalizedQuery,
        pageSize: 30,
        dataType: [
          "Branded",
        ],
      }),
    });

  if (!response.ok) {
    throw new Error(
      `USDA branded food search failed (${response.status}).`,
    );
  }

  const payload =
    await response.json();

  const foods =
    Array.isArray(payload?.foods)
      ? payload.foods
      : [];

  setLimitedCache(
    searchCache,
    cacheKey,
    foods,
    SEARCH_CACHE_LIMIT,
  );

  return foods;
}

async function fetchUsdaFood(
  fdcId,
  apiKey,
) {
  const key =
    String(fdcId);

  if (detailCache.has(key)) {
    return detailCache.get(key);
  }

  const url = new URL(
    `${USDA_BASE}/food/${encodeURIComponent(
      key,
    )}`,
  );

  url.searchParams.set(
    "api_key",
    apiKey,
  );

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `USDA food detail failed (${response.status}).`,
    );
  }

  const food =
    await response.json();

  setLimitedCache(
    detailCache,
    key,
    food,
    DETAIL_CACHE_LIMIT,
  );

  return food;
}

function nutrientAmount(
  food,
  nutrientNumber,
  namePatterns = [],
) {
  const nutrients =
    Array.isArray(food?.foodNutrients)
      ? food.foodNutrients
      : [];

  for (const entry of nutrients) {
    const nutrient =
      entry?.nutrient || {};

    if (
      String(
        nutrient?.number || "",
      ) === nutrientNumber
    ) {
      const amount =
        Number(entry?.amount);

      return Number.isFinite(amount)
        ? amount
        : null;
    }
  }

  for (const entry of nutrients) {
    const nutrientName =
      normalizeText(
        entry?.nutrient?.name,
      );

    if (
      namePatterns.some(
        (pattern) =>
          nutrientName.includes(
            normalizeText(pattern),
          ),
      )
    ) {
      const amount =
        Number(entry?.amount);

      return Number.isFinite(amount)
        ? amount
        : null;
    }
  }

  return null;
}

function nutrientsPer100g(food) {
  return {
    calories:
      nutrientAmount(
        food,
        "208",
        ["energy"],
      ) ?? 0,

    proteinG:
      nutrientAmount(
        food,
        "203",
        ["protein"],
      ) ?? 0,

    carbsG:
      nutrientAmount(
        food,
        "205",
        [
          "carbohydrate by difference",
          "carbohydrate",
        ],
      ) ?? 0,

    fatG:
      nutrientAmount(
        food,
        "204",
        [
          "total lipid fat",
          "total fat",
        ],
      ) ?? 0,

    fiberG:
      nutrientAmount(
        food,
        "291",
        [
          "fiber total dietary",
          "dietary fiber",
        ],
      ) ?? 0,

    sodiumMg:
      nutrientAmount(
        food,
        "307",
        [
          "sodium na",
          "sodium",
        ],
      ) ?? 0,
  };
}

function scaleNutrients(
  nutrients,
  grams,
) {
  const factor =
    grams / 100;

  return {
    calories:
      nutrients.calories *
      factor,

    proteinG:
      nutrients.proteinG *
      factor,

    carbsG:
      nutrients.carbsG *
      factor,

    fatG:
      nutrients.fatG *
      factor,

    fiberG:
      nutrients.fiberG *
      factor,

    sodiumMg:
      nutrients.sodiumMg *
      factor,
  };
}

function addNutrients(
  total,
  next,
) {
  total.calories +=
    next.calories;

  total.proteinG +=
    next.proteinG;

  total.carbsG +=
    next.carbsG;

  total.fatG +=
    next.fatG;

  total.fiberG +=
    next.fiberG;

  total.sodiumMg +=
    next.sodiumMg;
}

function roundNutrition(
  value,
) {
  return {
    calories:
      Math.round(
        value.calories,
      ),

    proteinG:
      Math.round(
        value.proteinG * 10,
      ) / 10,

    carbsG:
      Math.round(
        value.carbsG * 10,
      ) / 10,

    fatG:
      Math.round(
        value.fatG * 10,
      ) / 10,

    fiberG:
      Math.round(
        value.fiberG * 10,
      ) / 10,

    sodiumMg:
      Math.round(
        value.sodiumMg,
      ),
  };
}

function divideNutrition(
  total,
  servings,
) {
  return {
    calories:
      total.calories / servings,

    proteinG:
      total.proteinG / servings,

    carbsG:
      total.carbsG / servings,

    fatG:
      total.fatG / servings,

    fiberG:
      total.fiberG / servings,

    sodiumMg:
      total.sodiumMg / servings,
  };
}

function resolutionQuality(
  result,
) {
  if (
    !result ||
    result.status !== "resolved"
  ) {
    return 0;
  }

  const match =
    result.match || {};

  const dataType =
    String(
      match.dataType || "",
    );

  const conversionMethod =
    String(
      result.conversionMethod || "",
    );

  let quality = 0.8;

  if (
    dataType === "Foundation" ||
    dataType === "SR Legacy"
  ) {
    quality = 1;
  } else if (
    dataType === "Survey (FNDDS)"
  ) {
    quality = 0.95;
  } else if (
    dataType === "Branded"
  ) {
    quality = 0.8;
  }

  if (
    conversionMethod ===
      "direct-weight"
  ) {
    quality += 0.05;
  }

  if (
    match.brandedFallback === true
  ) {
    const consensus =
      Number(
        match.consensusMatches,
      ) || 0;

    quality =
      consensus >= 3
        ? Math.min(
            quality,
            0.85,
          )
        : Math.min(
            quality,
            0.7,
          );
  }

  return Math.max(
    0,
    Math.min(1, quality),
  );
}

function nutritionQualityScore(
  resolved,
) {
  if (
    !Array.isArray(resolved) ||
    !resolved.length
  ) {
    return 0;
  }

  const total =
    resolved.reduce(
      (sum, result) =>
        sum +
        resolutionQuality(
          result,
        ),
      0,
    );

  return (
    total /
    resolved.length
  );
}

function confidenceForAnalysis(
  coverage,
  qualityScore,
) {
  if (
    coverage >= 0.9 &&
    qualityScore >= 0.85
  ) {
    return "high";
  }

  if (
    coverage >= 0.7 &&
    qualityScore >= 0.7
  ) {
    return "medium";
  }

  return "low";
}

async function parseIngredientsWithAI({
  openai,
  model,
  recipeName,
  ingredients,
}) {
  if (!openai) {
    throw new Error(
      "OpenAI is unavailable for ingredient parsing.",
    );
  }

  const prompt = `
Parse the recipe ingredients below into structured ingredient data for a nutrition calculator.

IMPORTANT:
- Do NOT estimate calories, nutrients, weights, or gram amounts.
- Do NOT invent missing quantities.
- Preserve the meaning of the original ingredient.
- Convert clear fractions to decimals.
- If an ingredient gives a package size, preserve it separately.
- "2 (14.5 oz) cans diced tomatoes" should become quantity 2, unit "can", packageSizeQuantity 14.5, packageSizeUnit "oz".
- For countable foods, use the count description as the unit when useful: "2 large eggs" -> quantity 2, unit "large", food "egg".
- If a brand is explicitly stated, place it in brand.
- If an ingredient offers alternatives with "or", use the first-listed food for nutrition matching while preserving the complete original text. Example: "4 slices American or Cheddar cheese" -> food "American cheese".
- Mark "to taste", garnish-only, and optional ingredients accurately.
- If no usable numeric quantity exists, quantity must be null.
- Return valid JSON only.

Return exactly this shape:

{
  "ingredients": [
    {
      "original": "...",
      "quantity": 1,
      "unit": "cup",
      "food": "whole milk",
      "brand": null,
      "packageSizeQuantity": null,
      "packageSizeUnit": null,
      "optional": false,
      "toTaste": false,
      "garnishOnly": false
    }
  ]
}

Recipe:
${recipeName || "Untitled recipe"}

Ingredients:
${ingredients}
  `.trim();

  const response =
    await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You parse recipe ingredient measurements for Simple Dinners nutrition analysis. You never provide or estimate nutrition values or weights. Return valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

  const content =
    response.choices?.[0]
      ?.message?.content || "";

  const parsed =
    parseJsonResponse(content);

  return Array.isArray(
    parsed?.ingredients,
  )
    ? parsed.ingredients
    : [];
}

function ingredientSearchQuery(
  ingredient,
) {
  const brand =
    String(
      ingredient?.brand || "",
    ).trim();

  let food =
    String(
      ingredient?.food || "",
    ).trim();

  let normalizedFood =
    normalizeText(food);

  if (
    normalizedFood === "vinegar"
  ) {
    food =
      "distilled vinegar";
    normalizedFood =
      normalizeText(food);
  }

  const originalIngredient =
    normalizeText(
      ingredient?.original,
    );

  // A plain egg search currently returns stale Foundation
  // records followed by prepared egg dishes. For a basic
  // whole-egg ingredient, ask USDA for the raw whole food
  // instead. The actual portion weight still comes entirely
  // from USDA foodPortions.
  if (
    normalizedFood === "egg" &&
    !/\b(boiled|poached|fried|scrambled|omelet|pickled)\b/.test(
      originalIngredient,
    )
  ) {
    food = "egg whole raw";
    normalizedFood =
      normalizeText(food);
  }

  if (
    normalizedFood.includes("fresh") &&
    !/\bcooked\b/.test(normalizedFood)
  ) {
    food = food
      .replace(/\bfresh\b/gi, " ")
      .replace(/\bbaby\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    food =
      `${food} raw`.trim();
  }

  return [
    brand,
    food,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function brandedFallbackSearchQuery(
  ingredient,
) {
  const original =
    String(
      ingredient?.original || "",
    ).trim();

  const parsedFood =
    String(
      ingredient?.food || "",
    ).trim();

  // Prefer the original ingredient wording here because the
  // parser may intentionally simplify the food name and drop
  // useful product descriptors.
  //
  // Example:
  //   original: "4 street taco-sized flour tortillas"
  //   parsed food: "flour tortilla"
  //
  // USDA branded search needs "street taco flour tortillas"
  // to find the correct smaller tortilla products.
  let query =
    original || parsedFood;

  query = query
    // Remove a leading recipe quantity.
    .replace(
      /^\s*(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*/i,
      "",
    )

    // Remove ordinary measurement units immediately following
    // the quantity while keeping descriptive count language
    // such as "street taco-sized".
    .replace(
      /^(?:tsp|teaspoons?|tbsp|tbs|tablespoons?|cups?|oz|ounces?|lb|lbs|pounds?|g|grams?|kg|kilograms?|ml|milliliters?|l|liters?|cloves?|slices?)\b\s*/i,
      "",
    )

    .replace(
      /\b(dry|uncooked|raw|fresh)\b/gi,
      " ",
    )

    // "street taco-sized flour tortillas"
    // becomes "street taco flour tortillas".
    .replace(
      /[-\s]+sized\b/gi,
      " ",
    )
    .replace(
      /\bsize\b/gi,
      " ",
    )

    // Preparation wording usually hurts branded-product search.
    .replace(
      /\b(finely|roughly|freshly|minced|diced|chopped|shredded|grated|drained)\b/gi,
      " ",
    )

    .replace(/[,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return query || parsedFood;
}

function dedupeParsedIngredients(
  ingredients,
) {
  const seen =
    new Set();

  return (
    Array.isArray(ingredients)
      ? ingredients
      : []
  ).filter((ingredient) => {
    const key =
      JSON.stringify([
        normalizeText(
          ingredient?.original,
        ),
        Number.isFinite(
          Number(
            ingredient?.quantity,
          ),
        )
          ? Number(
            ingredient?.quantity,
          )
          : null,
        normalizeUnit(
          ingredient?.unit,
        ),
        normalizeText(
          ingredient?.food,
        ),
        normalizeText(
          ingredient?.brand,
        ),
        ingredient
          ?.packageSizeQuantity ??
          null,
        normalizeUnit(
          ingredient
            ?.packageSizeUnit,
        ),
        ingredient?.optional ===
          true,
        ingredient?.toTaste ===
          true,
        ingredient
          ?.garnishOnly === true,
      ]);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function shouldExcludeFromCoverage(
  ingredient,
) {
  return (
    ingredient?.toTaste === true ||
    ingredient?.garnishOnly === true ||
    (
      ingredient?.optional === true &&
      !Number.isFinite(
        Number(ingredient?.quantity),
      )
    )
  );
}

async function resolveIngredient({
  ingredient,
  apiKey,
}) {
  const query =
    ingredientSearchQuery(
      ingredient,
    );

  if (!query) {
    return {
      status: "unresolved",
      reason: "missing-food-name",
      ingredient,
    };
  }

  const foods =
    await searchUsdaFood(
      query,
      apiKey,
      ingredient,
    );

  const ranked =
    rankFoodCandidates(
      foods,
      ingredient,
    );

  // The highest-ranked USDA food is not always the one with
  // household portion data. Try several strong candidates so
  // measurements such as teaspoons, tablespoons, cups, slices,
  // and individual pieces can resolve without inventing weights.
  const candidatesToTry =
    ranked.slice(0, 6);

  for (
    const selected
    of candidatesToTry
  ) {
    if (!selected?.food?.fdcId) {
      continue;
    }

    let food;

    try {
      food =
        await fetchUsdaFood(
          selected.food.fdcId,
          apiKey,
        );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "";

      // USDA search can occasionally return an ID whose
      // detail record is no longer available. Try the next
      // ranked match instead of failing the ingredient.
      if (
        message.includes("(404)")
      ) {
        continue;
      }

      throw error;
    }

    const gramResult =
      ingredientToGrams(
        food,
        ingredient,
      );

    if (!gramResult) {
      continue;
    }

    const per100g =
      nutrientsPer100g(food);

    const nutrients =
      scaleNutrients(
        per100g,
        gramResult.grams,
      );

    return {
      status: "resolved",
      ingredient,
      grams:
        Math.round(
          gramResult.grams * 10,
        ) / 10,
      conversionMethod:
        gramResult.method,
      match: {
        fdcId:
          selected.food.fdcId,
        description:
          selected.food.description,
        dataType:
          selected.food.dataType,
        score:
          selected.score,
      },
      nutrients:
        roundNutrition(nutrients),
    };
  }

  let brandedCandidatesToTry = [];

  if (
    !isBrandRequested(
      ingredient,
    )
  ) {
    const brandedQuery =
      brandedFallbackSearchQuery(
        ingredient,
      );

    const brandedFoods =
      await searchUsdaBrandedFood(
        brandedQuery,
        apiKey,
      );

    const rankedBranded =
      rankFoodCandidates(
        brandedFoods,
        ingredient,
      )
        .filter(
          (candidate) =>
            candidate.score > 0,
        );

    const bestIdentityOverlap =
      rankedBranded.reduce(
        (best, candidate) =>
          Math.max(
            best,
            Number(
              candidate?.identity
                ?.overlap,
            ) || 0,
          ),
        0,
      );

    brandedCandidatesToTry =
      rankedBranded
        .filter(
          (candidate) =>
            (
              Number(
                candidate?.identity
                  ?.overlap,
              ) || 0
            ) ===
            bestIdentityOverlap,
        )
        .slice(0, 12);

    const brandedResolved = [];

    for (
      const selected
      of brandedCandidatesToTry
    ) {
      if (
        !selected?.food?.fdcId
      ) {
        continue;
      }

      let food;

      try {
        food =
          await fetchUsdaFood(
            selected.food.fdcId,
            apiKey,
          );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "";

        if (
          message.includes("(404)")
        ) {
          continue;
        }

        throw error;
      }

      const gramResult =
        ingredientToGrams(
          food,
          ingredient,
        );

      if (
        !gramResult ||
        ![
          "usda-branded-household",
          "usda-branded-count",
        ].includes(
          gramResult.method,
        )
      ) {
        continue;
      }

      brandedResolved.push({
        selected,
        food,
        gramResult,
      });
    }

    if (
      brandedResolved.length
    ) {
      const sortedWeights =
        brandedResolved
          .map(
            (item) =>
              item.gramResult
                .grams,
          )
          .sort(
            (a, b) =>
              a - b,
          );

      const middle =
        Math.floor(
          sortedWeights.length /
          2,
        );

      const median =
        sortedWeights.length % 2
          ? sortedWeights[middle]
          : (
            sortedWeights[
              middle - 1
            ] +
            sortedWeights[
              middle
            ]
          ) / 2;

      const chosen =
        brandedResolved
          .slice()
          .sort(
            (a, b) =>
              Math.abs(
                a.gramResult
                  .grams -
                median,
              ) -
              Math.abs(
                b.gramResult
                  .grams -
                median,
              ),
          )[0];

      const per100g =
        nutrientsPer100g(
          chosen.food,
        );

      const nutrients =
        scaleNutrients(
          per100g,
          chosen.gramResult
            .grams,
        );

      return {
        status: "resolved",
        ingredient,
        grams:
          Math.round(
            chosen.gramResult
              .grams * 10,
          ) / 10,
        conversionMethod:
          chosen.gramResult
            .method,
        match: {
          fdcId:
            chosen.selected
              .food.fdcId,
          description:
            chosen.selected
              .food.description,
          dataType:
            chosen.selected
              .food.dataType,
          score:
            chosen.selected
              .score,
          brandedFallback:
            true,
          consensusMatches:
            brandedResolved
              .length,
        },
        nutrients:
          roundNutrition(
            nutrients,
          ),
      };
    }
  }

  const best =
    ranked[0] ||
    brandedCandidatesToTry[0];

  return {
    status: "unresolved",
    reason:
      "quantity-could-not-be-converted-to-grams",
    ingredient,
    match: {
      fdcId:
        best?.food?.fdcId,
      description:
        best?.food?.description,
      dataType:
        best?.food?.dataType,
    },
    attemptedMatches:
      [
        ...candidatesToTry,
        ...brandedCandidatesToTry,
      ].map(
        (candidate) => ({
          fdcId:
            candidate?.food?.fdcId,
          description:
            candidate?.food?.description,
          dataType:
            candidate?.food?.dataType,
          score:
            candidate?.score,
        }),
      ),
  };
}

function resultCacheKey({
  recipeName,
  ingredients,
  servings,
}) {
  return JSON.stringify({
    recipeName:
      String(recipeName || "")
        .trim(),
    ingredients:
      String(ingredients || "")
        .trim(),
    servings,
  });
}

export async function analyzeRecipeNutrition({
  openai,
  model =
    process.env.OPENAI_MODEL ||
    "gpt-5.5",
  apiKey =
    process.env.USDA_FDC_API_KEY,
  recipeName = "",
  ingredients,
  servings,
}) {
  if (!apiKey) {
    throw new Error(
      "USDA_FDC_API_KEY is not configured.",
    );
  }

  const cleanIngredients =
    String(ingredients || "")
      .trim();

  if (!cleanIngredients) {
    throw new Error(
      "Recipe ingredients are required.",
    );
  }

  const numericServings =
    Number(servings);

  if (
    !Number.isFinite(
      numericServings,
    ) ||
    numericServings <= 0 ||
    numericServings > 100
  ) {
    throw new Error(
      "Recipe servings must be between 1 and 100.",
    );
  }

  const cacheKey =
    resultCacheKey({
      recipeName,
      ingredients:
        cleanIngredients,
      servings:
        numericServings,
    });

  if (resultCache.has(cacheKey)) {
    return {
      ...resultCache.get(
        cacheKey,
      ),
      cached: true,
    };
  }

  const parsedIngredients =
    dedupeParsedIngredients(
      await parseIngredientsWithAI({
        openai,
        model,
        recipeName,
        ingredients:
          cleanIngredients,
      }),
    );

  if (!parsedIngredients.length) {
    throw new Error(
      "No recipe ingredients could be parsed.",
    );
  }

  const resolved = [];
  const unresolved = [];
  const excluded = [];

  const totals = {
    calories: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    fiberG: 0,
    sodiumMg: 0,
  };

  for (
    const ingredient
    of parsedIngredients
  ) {
    if (
      shouldExcludeFromCoverage(
        ingredient,
      )
    ) {
      excluded.push({
        ingredient,
        reason:
          ingredient?.toTaste
            ? "to-taste"
            : ingredient?.garnishOnly
              ? "garnish-only"
              : "optional-without-quantity",
      });

      continue;
    }

    try {
      const result =
        await resolveIngredient({
          ingredient,
          apiKey,
        });

      if (
        result.status ===
        "resolved"
      ) {
        resolved.push(result);

        addNutrients(
          totals,
          result.nutrients,
        );
      } else {
        unresolved.push(result);
      }
    } catch (error) {
      unresolved.push({
        status: "unresolved",
        reason:
          error instanceof Error
            ? error.message
            : "USDA lookup failed",
        ingredient,
      });
    }
  }

  const consideredCount =
    resolved.length +
    unresolved.length;

  const coverage =
    consideredCount > 0
      ? (
        resolved.length /
        consideredCount
      )
      : 0;

  const qualityScore =
    nutritionQualityScore(
      resolved,
    );

  const perRecipe =
    roundNutrition(totals);

  const perServing =
    roundNutrition(
      divideNutrition(
        totals,
        numericServings,
      ),
    );

  const result = {
    source:
      "USDA FoodData Central",
    estimated: true,
    servings:
      numericServings,
    coverage:
      Math.round(
        coverage * 100,
      ) / 100,
    qualityScore:
      Math.round(
        qualityScore * 100,
      ) / 100,
    confidence:
      confidenceForAnalysis(
        coverage,
        qualityScore,
      ),
    perRecipe,
    perServing,
    resolvedIngredients:
      resolved,
    unresolvedIngredients:
      unresolved,
    excludedIngredients:
      excluded,
    cached: false,
  };

  setLimitedCache(
    resultCache,
    cacheKey,
    result,
    RESULT_CACHE_LIMIT,
  );

  return result;
}

export function getNutritionCacheStats() {
  return {
    searches:
      searchCache.size,
    foods:
      detailCache.size,
    recipes:
      resultCache.size,
  };
}
