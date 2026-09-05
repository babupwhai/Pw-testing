import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { detectKind, fileNameFromUrl, humanSize } from "@/lib/link-utils";
import { buildPart } from "@/lib/hls.server";
import { editMessage, sendMessage, tgCall, tgUpload } from "@/lib/telegram.server";

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
  await supabaseAdmin.from("jobs").update(patch).eq("id", id);
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
async function processHls(job: JobRow, settings: Settings, deadline: number) {
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
      await processHls(job, settings, deadline);
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
  "id, chat_id, telegram_id, url, title, kind, attempts, status_message_id, batch_id, stream_url, selected_quality, segment_cursor, part_index, parts_sent";

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
