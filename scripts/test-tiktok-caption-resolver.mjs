import {
  resolveTikTokCaption,
} from "../tiktokCaptionResolver.js";

const sourceUrl =
  process.argv[2];

if (!sourceUrl) {
  console.error(
    "Usage: node scripts/test-tiktok-caption-resolver.mjs <TikTok URL>"
  );

  process.exit(1);
}

try {
  const result =
    await resolveTikTokCaption(
      sourceUrl
    );

  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        success: false,
        code:
          error?.code || "UNKNOWN_ERROR",
        statusCode:
          error?.statusCode || 500,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      null,
      2
    )
  );

  process.exit(1);
}
