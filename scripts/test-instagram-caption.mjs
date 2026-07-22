import {
  resolveInstagramCaption,
} from "../instagramCaptionResolver.js";

const DEFAULT_TEST_URL =
  "https://www.instagram.com/reel/DZnKxEHk5RL/";

const targetUrl =
  process.argv[2]?.trim() ||
  DEFAULT_TEST_URL;

try {
  console.log(
    "Reading Instagram caption..."
  );

  const result =
    await resolveInstagramCaption(
      targetUrl,
      {
        headless:
          process.env.HEADLESS !==
          "false",
      }
    );

  console.log(
    "\nInstagram caption result:"
  );

  console.log({
    success: result.success,
    sourceUrl: result.sourceUrl,
    navigationStatus:
      result.navigationStatus,
    title: result.title,
    imageUrl: result.imageUrl,
    captionSource:
      result.captionSource,
    captionScore:
      result.captionScore,
    candidateCount:
      result.candidateCount,
  });

  console.log("\nBest caption:");

  console.log(
    result.captionText ||
      "(No usable caption was exposed.)"
  );

  console.log(
    "\nTop caption candidates:"
  );

  console.log(
    JSON.stringify(
      result.candidates,
      null,
      2
    )
  );
} catch (error) {
  console.error(
    "\nCaption resolver failed:"
  );

  console.error(
    error instanceof Error
      ? error.message
      : error
  );

  if (error?.code) {
    console.error(
      `Code: ${error.code}`
    );
  }

  process.exitCode = 1;
}
