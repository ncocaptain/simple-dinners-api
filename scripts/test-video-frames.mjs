import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const inputPath = path.join(
  os.homedir(),
  "Desktop",
  "recipe-video-test.mp4"
);

const outputDirectory = path.resolve("tmp-video-test");
const outputPattern = path.join(outputDirectory, "frame-%02d.jpg");

if (!ffmpegPath) {
  throw new Error("The bundled FFmpeg binary could not be found.");
}

if (!existsSync(inputPath)) {
  throw new Error(
    `Test video not found at:\n${inputPath}`
  );
}

rmSync(outputDirectory, {
  recursive: true,
  force: true,
});

mkdirSync(outputDirectory, {
  recursive: true,
});

console.log("Extracting test frames...");

const result = spawnSync(
  ffmpegPath,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,

    // Extract one frame every two seconds.
    "-vf",
    "fps=1/2",

    // Stop after three frames for this test.
    "-frames:v",
    "3",

    // High-quality JPEG output.
    "-q:v",
    "2",

    outputPattern,
  ],
  {
    encoding: "utf8",
  }
);

if (result.status !== 0) {
  console.error(result.stderr || "FFmpeg frame extraction failed.");
  process.exit(result.status || 1);
}

const generatedFrames = readdirSync(outputDirectory)
  .filter((filename) => filename.endsWith(".jpg"))
  .sort();

if (generatedFrames.length === 0) {
  throw new Error("FFmpeg finished but did not create any frames.");
}

console.log(`Created ${generatedFrames.length} frame(s):`);

generatedFrames.forEach((filename) => {
  console.log(`- ${path.join(outputDirectory, filename)}`);
});