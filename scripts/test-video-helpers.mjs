import OpenAI from "openai";
import os from "node:os";
import path from "node:path";
import {
  cleanupVideoImportWorkspace,
  prepareVideoImportInputs,
} from "../videoImportHelpers.js";

if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    "OPENAI_API_KEY is not loaded in this terminal session."
  );
}

const videoPath = path.join(
  os.homedir(),
  "Desktop",
  "recipe-video-test.mp4"
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let preparedVideo = null;

try {
  console.log(
    "Preparing video import inputs..."
  );

  preparedVideo =
    await prepareVideoImportInputs(
      videoPath,
      {
        openai,
        language: "en",
        frameIntervalSeconds: 2,
        maxFrames: 6,
        frameWidth: 720,
      }
    );

  console.log("\nVideo preparation complete:");
  console.log({
    frameCount:
      preparedVideo.frameCount,
    hasAudio:
      preparedVideo.hasAudio,
    audioPath:
      preparedVideo.audioPath,
    workspaceDir:
      preparedVideo.workspaceDir,
  });

  console.log("\nTranscript:");
  console.log(
    preparedVideo.transcriptText ||
    "(No spoken transcript found.)"
  );

  console.log("\nExtracted frames:");

  preparedVideo.framePaths.forEach(
    (framePath) => {
      console.log(`- ${framePath}`);
    }
  );
} finally {
  if (preparedVideo?.workspaceDir) {
    await cleanupVideoImportWorkspace(
      preparedVideo.workspaceDir
    );

    console.log(
      "\nTemporary video workspace cleaned up."
    );
  }
}