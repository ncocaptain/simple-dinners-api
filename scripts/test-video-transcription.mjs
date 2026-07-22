import OpenAI, { toFile } from "openai";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const audioPath = path.resolve(
  "tmp-video-test",
  "audio-track.mp3"
);

const transcriptPath = path.resolve(
  "tmp-video-test",
  "audio-transcript.txt"
);

if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    "OPENAI_API_KEY is not loaded in this terminal session."
  );
}

if (!existsSync(audioPath)) {
  throw new Error(`Audio file not found at:\n${audioPath}`);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log("Transcribing test audio...");

const audioBuffer = readFileSync(audioPath);

const transcription = await openai.audio.transcriptions.create({
  file: await toFile(audioBuffer, "audio-track.mp3"),
  model:
    process.env.OPENAI_TRANSCRIPTION_MODEL ||
    "whisper-1",
  language: "en",
});

const transcript = String(transcription.text || "").trim();

if (!transcript) {
  throw new Error(
    "Transcription completed but returned no text."
  );
}

writeFileSync(transcriptPath, transcript, "utf8");

console.log("Transcript:");
console.log(transcript);

console.log(`\nSaved transcript:\n- ${transcriptPath}`);