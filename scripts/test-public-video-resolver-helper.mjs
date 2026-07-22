import {
  cleanupPublicVideoResolverWorkspace,
  createPublicVideoResolverWorkspace,
  resolvePublicVideoToFile,
} from "../publicVideoResolver.js";

const DEFAULT_TEST_URL =
  "https://www.instagram.com/reel/DZnKxEHk5RL/";

const targetUrl =
  process.argv[2]?.trim() ||
  DEFAULT_TEST_URL;

const workspaceDir =
  await createPublicVideoResolverWorkspace();

let keepWorkspace = false;

try {
  console.log(
    "Resolving public Instagram video..."
  );

  const result =
    await resolvePublicVideoToFile(
      targetUrl,
      {
        workspaceDir,
        headless:
          process.env.HEADLESS !==
          "false",
      }
    );

  keepWorkspace = true;

  console.log(
    "\nPublic video resolved:"
  );

  console.log({
    platform: result.platform,
    sourceUrl: result.sourceUrl,
    outputPath: result.outputPath,
    sizeBytes: result.sizeBytes,
    hasAudio: result.hasAudio,
    durationSeconds:
      result.durationSeconds,
    candidateCount:
      result.candidateCount,
    uniqueTrackCount:
      result.uniqueTrackCount,
    videoTrack:
      result.videoTrack,
    audioTrack:
      result.audioTrack,
  });

  console.log(
    "\nThe workspace was kept so you can open the generated MP4."
  );

  console.log(
    `Open it with:\nopen "${result.outputPath}"`
  );
} catch (error) {
  console.error(
    "\nPublic video resolver failed:"
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

  if (error?.debug) {
    console.error(
      "Debug:",
      error.debug
    );
  }

  process.exitCode = 1;
} finally {
  if (!keepWorkspace) {
    await cleanupPublicVideoResolverWorkspace(
      workspaceDir
    );
  }
}
