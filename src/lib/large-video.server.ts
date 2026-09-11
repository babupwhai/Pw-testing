import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tgCall } from "@/lib/telegram.server";

const TELEGRAM_FILE_LIMIT = 2_000 * 1024 * 1024;

export type DownloadProgress = {
  bytes: number;
  bytesPerSecond: number;
  elapsedMs: number;
  mediaTimeSec: number;
  ffmpegSpeed: string;
};

export type DownloadResult = {
  size: number;
  elapsedMs: number;
  averageBytesPerSecond: number;
};

export type VideoMetadata = {
  durationSec: number;
  width: number;
  height: number;
};

export function localBotApiConfigured() {
  const base = process.env["TELEGRAM_LOCAL_API_BASE"]?.trim();
  return Boolean(base && /^https?:\/\//.test(base));
}

export async function downloadHlsAsMp4(
  streamUrl: string,
  outputPath: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<DownloadResult> {
  const binary = process.env["FFMPEG_PATH"]?.trim() || "ffmpeg";
  const referer = new URL(streamUrl).origin;
  const startedAt = Date.now();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-progress",
      "pipe:1",
      "-stats_period",
      "2",
      "-headers",
      `User-Agent: Mozilla/5.0\r\nReferer: ${referer}\r\n`,
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "8",
      "-fflags",
      "+genpts",
      "-i",
      streamUrl,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+faststart",
      outputPath,
    ]);

    let stderr = "";
    let stdoutBuffer = "";
    let bytes = 0;
    let mediaTimeSec = 0;
    let ffmpegSpeed = "?";
    let previousBytes = 0;
    let previousAt = startedAt;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const separator = line.indexOf("=");
        if (separator < 0) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (key === "total_size") bytes = Number(value) || bytes;
        if (key === "out_time_us") mediaTimeSec = (Number(value) || 0) / 1_000_000;
        if (key === "speed") ffmpegSpeed = value || "?";
        if (key === "progress") {
          const now = Date.now();
          const intervalSec = Math.max(0.001, (now - previousAt) / 1000);
          const bytesPerSecond = Math.max(0, (bytes - previousBytes) / intervalSec);
          onProgress?.({
            bytes,
            bytesPerSecond,
            elapsedMs: now - startedAt,
            mediaTimeSec,
            ffmpegSpeed,
          });
          previousBytes = bytes;
          previousAt = now;
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-3000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const skippedSegment = /failed to open segment|error when loading first segment|HTTP error/i.test(stderr);
      if (code === 0 && !skippedSegment) resolve();
      else reject(new Error(`Full MP4 nahi ban paya (FFmpeg ${code}): ${stderr.slice(-500)}`));
    });
  });

  const info = await stat(outputPath);
  if (!info.size) throw new Error("Full MP4 empty bana");
  if (info.size > TELEGRAM_FILE_LIMIT) {
    throw new Error(`Telegram file limit cross ho gayi (${Math.ceil(info.size / 1024 / 1024)} MB)`);
  }
  const elapsedMs = Date.now() - startedAt;
  return {
    size: info.size,
    elapsedMs,
    averageBytesPerSecond: info.size / Math.max(0.001, elapsedMs / 1000),
  };
}

export async function probeVideo(path: string): Promise<VideoMetadata> {
  const binary = process.env["FFPROBE_PATH"]?.trim() || "ffprobe";
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height",
      "-of",
      "json",
      path,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`ffprobe failed (${code}): ${stderr.slice(-300)}`)),
    );
  });
  const parsed = JSON.parse(output) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const durationSec = Number(parsed.format?.duration ?? 0);
  const width = Number(video?.width ?? 0);
  const height = Number(video?.height ?? 0);
  if (!durationSec || !width || !height) throw new Error("MP4 duration/resolution metadata missing");
  return { durationSec, width, height };
}

export async function generateVideoThumbnail(
  videoPath: string,
  thumbnailPath: string,
  durationSec: number,
): Promise<void> {
  const binary = process.env["FFMPEG_PATH"]?.trim() || "ffmpeg";
  const seekSec = Math.max(1, Math.min(30, durationSec * 0.1));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(seekSec),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=320:-2",
      "-q:v",
      "3",
      thumbnailPath,
    ]);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-1000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Thumbnail failed (${code}): ${stderr.slice(-300)}`)),
    );
  });
  if (!(await stat(thumbnailPath)).size) throw new Error("Generated thumbnail is empty");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function sendLargeVideo(params: {
  chatId: number;
  path: string;
  fileName: string;
  caption: string;
  thumbnailPath: string;
  metadata: VideoMetadata;
}) {
  if (!localBotApiConfigured()) {
    throw new Error("Local Telegram Bot API configured nahi hai");
  }

  const result = await tgCall("sendVideo", {
    chat_id: params.chatId,
    video: `file://${params.path}`,
    caption: params.caption,
    supports_streaming: true,
    duration: Math.round(params.metadata.durationSec),
    width: params.metadata.width,
    height: params.metadata.height,
    thumbnail: `file://${params.thumbnailPath}`,
  });
  if (!result.ok) throw new Error(result.error);
}