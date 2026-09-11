import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { detectKind, fileNameFromUrl, humanSize } from "@/lib/link-utils";
import { buildPart } from "@/lib/hls.server";
import { editMessage, sendMessage, tgCall, tgUpload } from "@/lib/telegram.server";
import {
  downloadHlsAsMp4,
  localBotApiConfigured,
  sendLargeVideo,
  sha256File,
} from "@/lib/large-video.server";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const UPLOAD_CEILING = 48 * 1024 * 1024; // Bot API limit for a single file

export type Settings = {
  default_daily_limit: number;
  max_file_mb: number;
  parallel_jobs: number;
  allow_all_users: boolean;
  welcome_text: string | null;
  max_part_mb: number;
};

export async function getSettings(): Promise<Settings> {
  const { data } = await supabaseAdmin.from("settings").select("*").eq("id", 1).maybeSingle();
  return {
    default_daily_limit: data?.default_daily_limit ?? 50,
    max_file_mb: data?.max_file_mb ?? 2000,
    parallel_jobs: data?.parallel_jobs ?? 3,
    allow_all_users: data?.allow_all_users ?? true,
    welcome_text: data?.welcome_text ?? null,
    max_part_mb: data?.max_part_mb ?? 45,
  };
}

export type JobRow = {
  id: string;
  chat_id: number;
  telegram_id: number;
  url: string;
  title: string | null;
  kind: string;
  attempts: number;
  status_message_id: number | null;
  batch_id: string | null;
  stream_url: string | null;
  selected_quality: string | null;
  segment_cursor: number;
  part_index: number;
  parts_sent: number;
  variants: Array<{
    url: string;
    label: string;
    estBytes: number | null;
    bandwidth?: number | null;
  }> | null;
};

function captionFor(job: JobRow, fileName: string) {
  const title = job.title?.trim();
  return title ? `${title}\n<code>${escapeHtml(fileName)}</code>` : `<code>${escapeHtml(fileName)}</code>`;
}

export function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Fastest path: hand Telegram the URL so no bytes pass through our server. */
async function sendByUrl(job: JobRow, kind: "video" | "document", fileName: string) {
  const method = kind === "video" ? "sendVideo" : "sendDocument";
  const payload: Record<string, unknown> = {
    chat_id: job.chat_id,
    caption: captionFor(job, fileName),
    parse_mode: "HTML",
    ...(kind === "video"
      ? { video: job.url, supports_streaming: true }
      : { document: job.url }),
  };
  return tgCall(method, payload);
}

/** Fallback: stream the file through the server and upload it as multipart. */
async function sendByUpload(
  job: JobRow,
  kind: "video" | "document",
  fileName: string,
  maxBytes: number,
) {
  const res = await fetch(job.url, {
    headers: { "user-agent": "Mozilla/5.0", referer: new URL(job.url).origin },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Link returned ${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared && declared > maxBytes) {
    throw new Error(`TOO_LARGE:${declared}`);
  }

  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`TOO_LARGE:${buffer.byteLength}`);
  }

  const type = res.headers.get("content-type") ?? "application/octet-stream";
  const form = new FormData();
  form.append("chat_id", String(job.chat_id));
  form.append("caption", captionFor(job, fileName));
  form.append("parse_mode", "HTML");
  if (kind === "video") form.append("supports_streaming", "true");
  form.append(
    kind === "video" ? "video" : "document",
    new Blob([buffer as unknown as BlobPart], { type }),
    fileName,
  );

  const result = await tgUpload(kind === "video" ? "sendVideo" : "sendDocument", form);
  return { result, size: buffer.byteLength };
}

type JobUpdate = Database["public"]["Tables"]["jobs"]["Update"];

async function updateJob(id: string, patch: JobUpdate) {
  const { error } = await supabaseAdmin.from("jobs").update(patch).eq("id", id);
  if (error) throw new Error(`Job update failed: ${error.message}`);
}

async function bumpBatch(batchId: string | null, ok: boolean) {
  if (!batchId) return;
  const { data: batch } = await supabaseAdmin
    .from("batches")
    .select("id, total, done, failed, chat_id")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return;
  const done = batch.done + (ok ? 1 : 0);
  const failed = batch.failed + (ok ? 0 : 1);
  await supabaseAdmin.from("batches").update({ done, failed }).eq("id", batchId);
  if (done + failed >= batch.total) {
    await sendMessage(
      batch.chat_id,
      `✅ Batch complete — <b>${done}</b> sent${failed ? `, <b>${failed}</b> failed` : ""}.`,
    );
  }
}

async function uploadVideoPart(
  job: JobRow,
  bytes: Uint8Array,
  fileName: string,
  caption: string,
) {
  const form = new FormData();
  form.append("chat_id", String(job.chat_id));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("supports_streaming", "true");
  form.append("video", new Blob([bytes as unknown as BlobPart], { type: "video/mp4" }), fileName);
  return tgUpload<{ message_id: number }>("sendVideo", form);
}

/**
 * Streams an HLS lecture of ANY size: it is delivered as consecutive playable
 * parts, and progress is saved so the next run continues where this one stopped.
 */
async function processHlsParts(job: JobRow, settings: Settings, deadline: number) {
  const mediaUrl = job.stream_url ?? job.url;
  const partBytes = Math.min(UPLOAD_CEILING, Math.max(5, settings.max_part_mb) * 1024 * 1024);
  const baseName =
    fileNameFromUrl(job.url, "video").replace(/\.m3u8.*$/i, "") || (job.title ?? "video");
  const statusId = job.status_message_id;
  const quality = job.selected_quality ? ` • ${job.selected_quality}` : "";

  let cursor = job.segment_cursor;
  let part = job.part_index;
  let sent = job.parts_sent;
  const startedAt = Date.now();

  for (;;) {
    if (statusId) {
      await editMessage(
        job.chat_id,
        statusId,
        `🎬 Part <b>${part + 1}</b> ban raha hai${quality}…\n<code>${escapeHtml(baseName)}</code>`,
      );
    }

    const result = await buildPart(mediaUrl, cursor, partBytes, deadline - 20_000);

    if (result.bytes.byteLength) {
      const label = result.done && part === 0 ? "" : ` part ${part + 1}`;
      const fileName = `${baseName}${label}.mp4`.replace(/\s+/g, " ");
      const caption =
        `${job.title ? `${escapeHtml(job.title)}\n` : ""}<code>${escapeHtml(fileName)}</code>` +
        `${job.selected_quality ? `\n${escapeHtml(job.selected_quality)}` : ""}` +
        `${result.done && part === 0 ? "" : `\nPart ${part + 1}`}`;
      const up = await uploadVideoPart(job, result.bytes, fileName, caption);
      if (!up.ok) throw new Error(up.error);
      part += 1;
      sent += 1;
    }

    cursor = result.nextIndex;
    const pct = result.totalSegments
      ? Math.min(100, Math.round((cursor / result.totalSegments) * 100))
      : 0;

    await updateJob(job.id, {
      segment_cursor: cursor,
      part_index: part,
      parts_sent: sent,
      progress: pct,
    });

    if (result.done) {
      await updateJob(job.id, {
        status: "done",
        progress: 100,
        file_name: `${baseName}.mp4`,
        method: "hls",
        ms_taken: Date.now() - startedAt,
        finished_at: new Date().toISOString(),
        error: null,
      });
      await bumpBatch(job.batch_id, true);
      if (statusId) {
        await editMessage(
          job.chat_id,
          statusId,
          sent > 1
            ? `✅ Poora lecture bhej diya — <b>${sent}</b> parts${quality}.`
            : `✅ Sent: <code>${escapeHtml(baseName)}.mp4</code>${quality}`,
        );
      }
      return;
    }

    if (Date.now() > deadline - 25_000) {
      // Park the job; the next queue run resumes from the saved cursor.
      await updateJob(job.id, { status: "queued" });
      if (statusId) {
        await editMessage(
          job.chat_id,
          statusId,
          `⏳ ${pct}% done — <b>${sent}</b> parts bheje. Baaki thodi der me aayega${quality}.`,
        );
      }
      return;
    }
  }
}

function safeVideoName(job: JobRow) {
  const fromTitle = job.title?.trim() || fileNameFromUrl(job.url, "lecture");
  const base = fromTitle
    .replace(/\.m3u8.*$/i, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${base || "lecture"}.mp4`;
}

function durationLabel(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours
    ? `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${mins}:${String(secs).padStart(2, "0")}`;
}

function speedLabel(bytesPerSecond: number) {
  return `${(bytesPerSecond / 1024 / 1024).toFixed(bytesPerSecond >= 10 * 1024 * 1024 ? 1 : 2)} MB/s`;
}

async function processHlsSingle(job: JobRow, startedAt: number) {
  const statusId = job.status_message_id;
  const quality = job.selected_quality ? ` • ${job.selected_quality}` : "";
  const fileName = safeVideoName(job);
  const dir = await mkdtemp(join(tmpdir(), "lecture-"));
  const outputPath = join(dir, fileName);
  const selected = job.variants?.find((variant) => variant.label === job.selected_quality);
  const expectedBytes = selected?.estBytes ?? null;
  const expectedDuration =
    selected?.bandwidth && selected.estBytes
      ? (selected.estBytes * 8) / selected.bandwidth
      : null;
  let latestDownloadText = "";
  let lastStatusAt = 0;
  let progressChain = Promise.resolve();

  try {
    if (statusId) {
      await editMessage(
        job.chat_id,
        statusId,
        `⬇️ Full MP4 ban raha hai${quality}…\n<code>${escapeHtml(fileName)}</code>\nIsme thoda time lag sakta hai.`,
      );
    }

    const download = await downloadHlsAsMp4(job.stream_url ?? job.url, outputPath, (metric) => {
      const now = Date.now();
      if (now - lastStatusAt < 7_000 || metric.bytes <= 0) return;
      lastStatusAt = now;
      const pct = expectedBytes
        ? Math.min(99, Math.max(1, Math.round((metric.bytes / expectedBytes) * 100)))
        : 0;
      const etaSec =
        expectedBytes && metric.bytesPerSecond > 0
          ? Math.max(0, (expectedBytes - metric.bytes) / metric.bytesPerSecond)
          : null;
      latestDownloadText = [
        `⬇️ <b>Downloading ${escapeHtml(job.selected_quality ?? "")}</b>`,
        `${expectedBytes ? `${pct}% • ` : ""}${humanSize(metric.bytes)}${expectedBytes ? ` / ~${humanSize(expectedBytes)}` : ""}`,
        `⚡ ${speedLabel(metric.bytesPerSecond)} • FFmpeg ${escapeHtml(metric.ffmpegSpeed)}`,
        `🎞 ${durationLabel(metric.mediaTimeSec)}${expectedDuration ? ` / ~${durationLabel(expectedDuration)}` : ""}${etaSec !== null ? ` • ETA ~${durationLabel(etaSec)}` : ""}`,
      ].join("\n");
      progressChain = progressChain
        .then(async () => {
          await updateJob(job.id, { progress: pct });
          if (statusId) await editMessage(job.chat_id, statusId, latestDownloadText);
          console.log(
            `[job ${job.id}] download ${pct || "?"}% ${humanSize(metric.bytes)} ${speedLabel(metric.bytesPerSecond)} media=${durationLabel(metric.mediaTimeSec)} ffmpeg=${metric.ffmpegSpeed}`,
          );
        })
        .catch((error) => console.error(`[job ${job.id}] progress update failed`, error));
    });
    await progressChain;
    const fileSize = download.size;
    const hash = await sha256File(outputPath);

    if (statusId) {
      await editMessage(
        job.chat_id,
        statusId,
        `⬆️ <b>Telegram upload shuru</b>${quality}\n${humanSize(fileSize)} • Download avg ${speedLabel(download.averageBytesPerSecond)}\nUpload ke dauran Telegram live bytes expose nahi karta; elapsed time update hoga.`,
      );
    }

    const uploadStartedAt = Date.now();
    const uploadTicker = setInterval(() => {
      const elapsed = Date.now() - uploadStartedAt;
      if (statusId) {
        void editMessage(
          job.chat_id,
          statusId,
          `⬆️ <b>Telegram par upload ho raha hai</b>${quality}\n${humanSize(fileSize)} • elapsed ${durationLabel(elapsed / 1000)}\n⬇️ Download avg ${speedLabel(download.averageBytesPerSecond)}`,
        ).catch((error) => console.error(`[job ${job.id}] upload status failed`, error));
      }
    }, 10_000);
    let uploadElapsedMs = 0;
    try {
    await sendLargeVideo({
      chatId: job.chat_id,
      path: outputPath,
      fileName,
      caption:
        `${job.title?.trim() || fileName}\n${job.selected_quality ?? ""}`.trim() +
        `\nSHA-256: ${hash}`,
    });
      uploadElapsedMs = Date.now() - uploadStartedAt;
    } finally {
      clearInterval(uploadTicker);
    }
    const uploadAverage = fileSize / Math.max(0.001, uploadElapsedMs / 1000);

    await finish(job, {
      file_name: fileName,
      file_size: fileSize,
      method: "local-bot-api",
      ms: Date.now() - startedAt,
    });
    if (statusId) {
      await editMessage(
        job.chat_id,
        statusId,
        `✅ Full lecture ek MP4 me bhej diya${quality}.\n⬇️ Download avg ${speedLabel(download.averageBytesPerSecond)} • ⬆️ Upload avg ${speedLabel(uploadAverage)}\n⏱ Total ${durationLabel((Date.now() - startedAt) / 1000)}\n<code>SHA-256: ${hash}</code>`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function processHls(job: JobRow, settings: Settings, deadline: number, startedAt: number) {
  if (localBotApiConfigured()) {
    try {
      await processHlsSingle(job, startedAt);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("single MP4 delivery failed; falling back to parts", message);
      if (job.status_message_id) {
        await editMessage(
          job.chat_id,
          job.status_message_id,
          `⚠️ Single MP4 upload nahi hua (${escapeHtml(message.slice(0, 160))}). Parts fallback shuru…`,
        );
      }
    }
  }
  await processHlsParts(job, settings, deadline);
}

export async function processJob(
  job: JobRow,
  settings: Settings,
  deadline = Date.now() + 40_000,
): Promise<void> {
  const startedAt = Date.now();
  const maxBytes = Math.min(UPLOAD_CEILING, settings.max_file_mb * 1024 * 1024);
  const kind = job.kind === "auto" ? detectKind(job.url) : (job.kind as "video" | "document" | "hls");

  await updateJob(job.id, {
    status: "processing",
    attempts: job.attempts + 1,
    started_at: new Date().toISOString(),
    kind,
  });

  const statusId = job.status_message_id;
  const setStatus = async (text: string) => {
    if (statusId) await editMessage(job.chat_id, statusId, text);
  };

  try {
    if (kind === "hls") {
      await processHls(job, settings, deadline, startedAt);
      return;
    }

    const fileName = fileNameFromUrl(job.url, kind === "video" ? "video.mp4" : "file");
    await setStatus(`⚡ Sending <code>${escapeHtml(fileName)}</code>…`);

    const direct = await sendByUrl(job, kind, fileName);
    if (direct.ok) {
      await finish(job, { file_name: fileName, method: "url", ms: Date.now() - startedAt });
      if (statusId) await editMessage(job.chat_id, statusId, `✅ Sent: <code>${escapeHtml(fileName)}</code>`);
      return;
    }

    await setStatus(`⬇️ Downloading <code>${escapeHtml(fileName)}</code>…`);
    const uploaded = await sendByUpload(job, kind, fileName, maxBytes);
    if (!uploaded.result.ok) throw new Error(uploaded.result.error);

    await finish(job, {
      file_name: fileName,
      file_size: uploaded.size,
      method: "upload",
      ms: Date.now() - startedAt,
    });
    if (statusId) await editMessage(job.chat_id, statusId, `✅ Sent: <code>${escapeHtml(fileName)}</code>`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Single files above Telegram's per-file ceiling: hand over the direct link.
    const tooLarge = /^TOO_LARGE:(\d+)$/.exec(message);
    if (tooLarge) {
      const size = Number(tooLarge[1]);
      const fileName = fileNameFromUrl(job.url, "file");
      await sendMessage(
        job.chat_id,
        `📦 <b>${escapeHtml(fileName)}</b> — ${humanSize(size)}\nTelegram ek file me ${humanSize(maxBytes)} se zyada nahi leta, isliye direct download link:\n${escapeHtml(job.url)}`,
      );
      await finish(job, {
        file_name: fileName,
        file_size: size,
        method: "link",
        ms: Date.now() - startedAt,
      });
      if (statusId) await editMessage(job.chat_id, statusId, `🔗 Link bhej diya: <code>${escapeHtml(fileName)}</code>`);
      return;
    }

    await updateJob(job.id, {
      status: "failed",
      error: message.slice(0, 500),
      finished_at: new Date().toISOString(),
      ms_taken: Date.now() - startedAt,
    });
    await bumpBatch(job.batch_id, false);
    if (statusId) {
      await editMessage(job.chat_id, statusId, `❌ Failed: ${escapeHtml(message.slice(0, 300))}`);
    } else {
      await sendMessage(job.chat_id, `❌ Failed: ${escapeHtml(message.slice(0, 300))}`);
    }
  }
}

async function finish(
  job: JobRow,
  info: { file_name: string; file_size?: number; method: string; ms: number },
) {
  await updateJob(job.id, {
    status: "done",
    progress: 100,
    file_name: info.file_name,
    file_size: info.file_size ?? null,
    method: info.method,
    ms_taken: info.ms,
    finished_at: new Date().toISOString(),
    error: null,
  });
  await bumpBatch(job.batch_id, true);
}

const JOB_FIELDS =
  "id, chat_id, telegram_id, url, title, kind, attempts, status_message_id, batch_id, stream_url, selected_quality, segment_cursor, part_index, parts_sent, variants";

export async function recoverInterruptedJobs() {
  const { error } = await supabaseAdmin
    .from("jobs")
    .update({ status: "queued", error: "Dyno restart ke baad automatically resumed" })
    .in("status", ["claimed", "processing"]);
  if (error) throw new Error(`Interrupted job recovery failed: ${error.message}`);
}

/** Claims and runs queued jobs until the time budget runs out. */
export async function runQueue(budgetMs = 40_000): Promise<{ processed: number; remaining: number }> {
  const settings = await getSettings();
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  const maxJobsPerRun = Math.max(1, Math.min(10, settings.parallel_jobs * 2));

  while (Date.now() < deadline - 5_000 && processed < maxJobsPerRun) {
    const { data: queued } = await supabaseAdmin
      .from("jobs")
      .select(JOB_FIELDS)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .order("position", { ascending: true })
      .limit(Math.min(Math.max(1, settings.parallel_jobs), maxJobsPerRun - processed));

    if (!queued?.length) break;

    const claimed: JobRow[] = [];
    for (const job of queued as unknown as JobRow[]) {
      const { data } = await supabaseAdmin
        .from("jobs")
        .update({ status: "claimed" })
        .eq("id", job.id)
        .eq("status", "queued")
        .select("id");
      if (data?.length) claimed.push(job);
    }
    if (!claimed.length) break;

    const streams = claimed.filter((j) => j.kind === "hls");
    const rest = claimed.filter((j) => j.kind !== "hls");

    // Streams are memory heavy, so they run one at a time; plain links go parallel.
    await Promise.all(rest.map((job) => processJob(job, settings, deadline)));
    for (const job of streams) {
      if (Date.now() > deadline - 20_000) {
        await updateJob(job.id, { status: "queued" });
        continue;
      }
      await processJob(job, settings, deadline);
    }
    processed += claimed.length;
  }

  const { count } = await supabaseAdmin
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");

  return { processed, remaining: count ?? 0 };
}

let backgroundQueue: Promise<void> | null = null;

export function startQueueInBackground() {
  if (backgroundQueue) return false;
  backgroundQueue = runQueue(6 * 60 * 60 * 1000)
    .then((result) => console.log(`[queue] background run complete: ${JSON.stringify(result)}`))
    .catch((error) => console.error("[queue] background run failed", error))
    .finally(() => {
      backgroundQueue = null;
    });
  return true;
}
