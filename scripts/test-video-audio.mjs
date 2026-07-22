import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
const outputAudioPath = path.join(outputDirectory, "audio-track.mp3");

if (!ffmpegPath) {
  throw new Error("The bundled FFmpeg binary could not be found.");
}

if (!existsSync(inputPath)) {
  throw new Error(`Test video not found at:\n${inputPath}`);
}

rmSync(outputAudioPath, {
  force: true,
});

mkdirSync(outputDirectory, {
  recursive: true,
});

console.log("Extracting test audio...");

const result = spawnSync(
  ffmpegPath,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,

    "-vn",            // no video
    "-acodec",
    "mp3",
    "-ar",
    "44100",
    "-ac",
    "2",

    outputAudioPath,
  ],
  {
    encoding: "utf8",
  }
);

if (result.status !== 0) {
  console.error(result.stderr || "FFmpeg audio extraction failed.");
  process.exit(result.status || 1);
}

if (!existsSync(outputAudioPath)) {
  throw new Error("FFmpeg finished but did not create an audio file.");
}

console.log(`Created audio file:\n- ${outputAudioPath}`);