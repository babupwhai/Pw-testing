import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tgCall } from "@/lib/telegram.server";

const TELEGRAM_FILE_LIMIT = 2_000 * 1024 * 1024;

export function localBotApiConfigured() {
  const base = process.env["TELEGRAM_LOCAL_API_BASE"]?.trim();
  return Boolean(base && /^https?:\/\//.test(base));
}

export async function downloadHlsAsMp4(streamUrl: string, outputPath: string): Promise<number> {
  const binary = process.env["FFMPEG_PATH"]?.trim() || "ffmpeg";
  const referer = new URL(streamUrl).origin;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-headers",
      `User-Agent: Mozilla/5.0\r\nReferer: ${referer}\r\n`,
      "-i",
      streamUrl,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ]);

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-3000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Full MP4 nahi ban paya (FFmpeg ${code}): ${stderr.slice(-500)}`));
    });
  });

  const info = await stat(outputPath);
  if (!info.size) throw new Error("Full MP4 empty bana");
  if (info.size > TELEGRAM_FILE_LIMIT) {
    throw new Error(`Telegram file limit cross ho gayi (${Math.ceil(info.size / 1024 / 1024)} MB)`);
  }
  return info.size;
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
}) {
  if (!localBotApiConfigured()) {
    throw new Error("Local Telegram Bot API configured nahi hai");
  }

  const result = await tgCall("sendVideo", {
    chat_id: params.chatId,
    video: `file://${params.path}`,
    caption: params.caption,
    supports_streaming: true,
  });
  if (!result.ok) throw new Error(result.error);
}