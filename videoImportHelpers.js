import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toFile } from "openai";

const DEFAULT_FRAME_INTERVAL_SECONDS = 2;
const DEFAULT_MAX_FRAMES = 12;
const DEFAULT_FRAME_WIDTH = 720;
const DEFAULT_PROCESS_TIMEOUT_MS = 2 * 60 * 1000;


function stripVideoJsonCodeFence(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseVideoJsonResponse(value) {
  const cleaned = stripVideoJsonCodeFence(value);

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }

    throw new Error(
      "AI video analysis did not return valid JSON."
    );
  }
}

function requireFfmpegPath() {
  if (!ffmpegPath) {
    throw new Error("The bundled FFmpeg binary could not be found.");
  }

  return ffmpegPath;
}

async function assertReadableFile(filePath, label) {
  try {
    const fileStats = await stat(filePath);

    if (!fileStats.isFile() || fileStats.size === 0) {
      throw new Error(`${label} is empty or is not a file.`);
    }

    return fileStats;
  } catch (error) {
    if (error instanceof Error && error.message.includes(label)) {
      throw error;
    }

    throw new Error(`${label} could not be found at:\n${filePath}`);
  }
}

function runProcess(
  command,
  args,
  {
    timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    let timedOut = false;

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 40_000) {
        stderr += chunk.toString();
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);

      if (timedOut) {
        const error = new Error(
          `FFmpeg timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        );

        error.stderr = stderr;
        reject(error);
        return;
      }

      if (exitCode !== 0) {
        const error = new Error(
          stderr.trim() || `FFmpeg exited with code ${exitCode}.`
        );

        error.stderr = stderr;
        error.exitCode = exitCode;
        reject(error);
        return;
      }

      resolve({
        exitCode,
        stderr,
      });
    });
  });
}

function looksLikeMissingAudioError(error) {
  const message = String(
    error?.stderr ||
    error?.message ||
    ""
  );

  return (
    /output file does not contain any stream/i.test(message) ||
    /matches no streams/i.test(message) ||
    /stream map .* matches no streams/i.test(message) ||
    /does not contain an audio stream/i.test(message)
  );
}

export async function createVideoImportWorkspace() {
  return mkdtemp(
    path.join(os.tmpdir(), "simple-dinners-video-")
  );
}

export async function cleanupVideoImportWorkspace(workspaceDir) {
  if (!workspaceDir) return;

  await rm(workspaceDir, {
    recursive: true,
    force: true,
  });
}

export async function extractFramesFromVideo(
  videoPath,
  {
    workspaceDir,
    intervalSeconds = DEFAULT_FRAME_INTERVAL_SECONDS,
    maxFrames = DEFAULT_MAX_FRAMES,
    frameWidth = DEFAULT_FRAME_WIDTH,
  } = {}
) {
  requireFfmpegPath();
  await assertReadableFile(videoPath, "Video file");

  if (!workspaceDir) {
    throw new Error(
      "A video import workspace is required for frame extraction."
    );
  }

  if (
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds <= 0
  ) {
    throw new Error(
      "Frame interval must be greater than zero."
    );
  }

  if (!Number.isInteger(maxFrames) || maxFrames < 1) {
    throw new Error(
      "Maximum frame count must be at least one."
    );
  }

  const framesDirectory = path.join(
    workspaceDir,
    "frames"
  );

  await mkdir(framesDirectory, {
    recursive: true,
  });

  const outputPattern = path.join(
    framesDirectory,
    "frame-%03d.jpg"
  );

  await runProcess(requireFfmpegPath(), [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-vf",
    `fps=1/${intervalSeconds},scale=${frameWidth}:-2`,
    "-frames:v",
    String(maxFrames),
    "-q:v",
    "3",
    outputPattern,
  ]);

  const frameNames = (await readdir(framesDirectory))
    .filter((filename) =>
      /^frame-\d+\.jpg$/i.test(filename)
    )
    .sort();

  const framePaths = frameNames.map((filename) =>
    path.join(framesDirectory, filename)
  );

  if (framePaths.length === 0) {
    throw new Error(
      "FFmpeg finished but did not create any video frames."
    );
  }

  return framePaths;
}

export async function extractAudioFromVideo(
  videoPath,
  {
    workspaceDir,
  } = {}
) {
  requireFfmpegPath();
  await assertReadableFile(videoPath, "Video file");

  if (!workspaceDir) {
    throw new Error(
      "A video import workspace is required for audio extraction."
    );
  }

  const audioDirectory = path.join(
    workspaceDir,
    "audio"
  );

  await mkdir(audioDirectory, {
    recursive: true,
  });

  const audioPath = path.join(
    audioDirectory,
    "audio-track.mp3"
  );

  try {
    await runProcess(requireFfmpegPath(), [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,

      // Select the first audio stream when one exists.
      "-map",
      "0:a:0?",

      // Audio only.
      "-vn",

      // Small speech-friendly output.
      "-ac",
      "1",
      "-ar",
      "16000",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "64k",

      audioPath,
    ]);
  } catch (error) {
    if (looksLikeMissingAudioError(error)) {
      return {
        hasAudio: false,
        audioPath: null,
      };
    }

    throw error;
  }

  try {
    await assertReadableFile(
      audioPath,
      "Extracted audio file"
    );
  } catch {
    return {
      hasAudio: false,
      audioPath: null,
    };
  }

  return {
    hasAudio: true,
    audioPath,
  };
}

export async function transcribeAudioFile(
  audioPath,
  {
    openai,
    language = "en",
  } = {}
) {
  if (!audioPath) {
    return "";
  }

  if (!openai) {
    throw new Error(
      "An OpenAI client is required for audio transcription."
    );
  }

  await assertReadableFile(
    audioPath,
    "Audio file"
  );

  const audioBuffer = await readFile(audioPath);

  const audioFile = await toFile(
    audioBuffer,
    path.basename(audioPath),
    {
      type: "audio/mpeg",
    }
  );

  const transcriptionRequest = {
    file: audioFile,
    model:
      process.env.OPENAI_TRANSCRIPTION_MODEL ||
      "whisper-1",
  };

  const normalizedLanguage = String(
    language || ""
  )
    .trim()
    .toLowerCase()
    .slice(0, 2);

  if (normalizedLanguage) {
    transcriptionRequest.language =
      normalizedLanguage;
  }

  const transcription =
    await openai.audio.transcriptions.create(
      transcriptionRequest
    );

  return String(
    transcription?.text || ""
  ).trim();
}

export async function analyzeVideoRecipeEvidence(
  {
    framePaths,
    transcriptText = "",
  },
  {
    openai,
    language = "en",
  } = {}
) {
  if (!openai) {
    throw new Error(
      "An OpenAI client is required for video frame analysis."
    );
  }

  if (
    !Array.isArray(framePaths) ||
    framePaths.length === 0
  ) {
    throw new Error(
      "At least one extracted video frame is required."
    );
  }

  const content = [
    {
      type: "text",
      text: `
You are examining sampled frames and a spoken transcript from a cooking video for Simple Dinners.

This is an EVIDENCE EXTRACTION task, not recipe completion.

The frames may contain:
- recipe titles
- ingredient overlays
- measurements
- cooking instructions
- temperatures
- cooking times
- captions
- unrelated social media interface text

The spoken transcript may contain:
- ingredient names and quantities
- cooking actions
- temperatures and times
- narration unrelated to the recipe

YOUR JOB:
1. Faithfully extract recipe-related text visible in the sampled frames.
2. Extract recipe-related information explicitly spoken in the transcript.
3. Combine both sources into one readable evidence block.
4. Remove duplicate information when the same fact appears visually and verbally.
5. Preserve quantities, temperatures, and times exactly when possible.

STRICT RULES:
- Do not invent ingredients.
- Do not invent quantities.
- Do not invent temperatures, times, or cooking steps.
- Do not assume an ingredient was used merely because it appears visually.
- Do not complete missing recipe details from general cooking knowledge.
- Ignore usernames, likes, comments, buttons, watermarks, and unrelated interface text.
- Sampled frames may miss content between frames, so report uncertainty honestly.
- A recipe title must come from visible or spoken evidence. Do not infer a title yet.

Return valid JSON only:

{
  "hasRecipeContent": true,
  "title": "",
  "titleSource": "visible",
  "visibleRecipeText": "",
  "spokenRecipeText": "",
  "combinedRecipeText": "",
  "ingredientsAppearComplete": false,
  "instructionsAppearComplete": false,
  "possibleMissingContent": true,
  "warnings": []
}

TITLE SOURCE:
Use exactly one:
- "visible"
- "spoken"
- "visible-and-spoken"
- "unknown"

COMPLETENESS:
- ingredientsAppearComplete is true only if the video evidence appears to include a complete ingredient list.
- instructionsAppearComplete is true only if the evidence appears to include the complete cooking method.
- possibleMissingContent should be true when sampled frames, fast editing, missing narration, or incomplete overlays may have omitted recipe details.

Language hint:
${String(language || "en")}

Spoken transcript:
${String(transcriptText || "").trim() ||
        "(No spoken transcript was available.)"
        }
      `.trim(),
    },
  ];

  for (const framePath of framePaths) {
    await assertReadableFile(
      framePath,
      "Video frame"
    );

    const frameBuffer = await readFile(framePath);

    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${frameBuffer.toString(
          "base64"
        )}`,
      },
    });
  }

  const response =
    await openai.chat.completions.create({
      model:
        process.env.OPENAI_VISION_MODEL ||
        process.env.OPENAI_MODEL ||
        "gpt-5.5",
      messages: [
        {
          role: "system",
          content:
            "You faithfully extract recipe evidence from cooking-video frames and spoken transcripts. Never invent missing recipe content. Return valid JSON only.",
        },
        {
          role: "user",
          content,
        },
      ],
    });

  const raw =
    response.choices?.[0]?.message?.content || "";

  const parsed = parseVideoJsonResponse(raw);

  const allowedTitleSources = new Set([
    "visible",
    "spoken",
    "visible-and-spoken",
    "unknown",
  ]);

  const titleSource = allowedTitleSources.has(
    parsed?.titleSource
  )
    ? parsed.titleSource
    : "unknown";

  return {
    hasRecipeContent:
      parsed?.hasRecipeContent === true,

    title: String(parsed?.title || "").trim(),

    titleSource,

    visibleRecipeText: String(
      parsed?.visibleRecipeText || ""
    ).trim(),

    spokenRecipeText: String(
      parsed?.spokenRecipeText || ""
    ).trim(),

    combinedRecipeText: String(
      parsed?.combinedRecipeText || ""
    ).trim(),

    ingredientsAppearComplete:
      parsed?.ingredientsAppearComplete === true,

    instructionsAppearComplete:
      parsed?.instructionsAppearComplete === true,

    possibleMissingContent:
      parsed?.possibleMissingContent !== false,

    warnings: Array.isArray(parsed?.warnings)
      ? parsed.warnings
        .map((warning) =>
          String(warning || "").trim()
        )
        .filter(Boolean)
      : [],
  };
}

export async function prepareVideoImportInputs(
  videoPath,
  {
    openai,
    language = "en",
    frameIntervalSeconds =
    DEFAULT_FRAME_INTERVAL_SECONDS,
    maxFrames = DEFAULT_MAX_FRAMES,
    frameWidth = DEFAULT_FRAME_WIDTH,
  } = {}
) {
  const workspaceDir =
    await createVideoImportWorkspace();

  try {
    const framePaths =
      await extractFramesFromVideo(videoPath, {
        workspaceDir,
        intervalSeconds:
          frameIntervalSeconds,
        maxFrames,
        frameWidth,
      });

    const audioResult =
      await extractAudioFromVideo(videoPath, {
        workspaceDir,
      });

    const transcriptText =
      audioResult.hasAudio
        ? await transcribeAudioFile(
          audioResult.audioPath,
          {
            openai,
            language,
          }
        )
        : "";

    return {
      workspaceDir,
      framePaths,
      frameCount: framePaths.length,
      hasAudio: audioResult.hasAudio,
      audioPath: audioResult.audioPath,
      transcriptText,
    };
  } catch (error) {
    await cleanupVideoImportWorkspace(
      workspaceDir
    );

    throw error;
  }
}