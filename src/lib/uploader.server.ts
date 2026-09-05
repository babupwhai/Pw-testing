import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { detectKind, fileNameFromUrl, humanSize } from "@/lib/link-utils";
import { hlsToMp4 } from "@/lib/hls.server";
import { editMessage, sendMessage, tgCall, tgUpload } from "@/lib/telegram.server";

const UPLOAD_CEILING = 48 * 1024 * 1024; // Bot API limit for our own uploads

export type Settings = {
  default_daily_limit: number;
  max_file_mb: number;
  parallel_jobs: number;
  allow_all_users: boolean;
  welcome_text: string | null;
};

export async function getSettings(): Promise<Settings> {
  const { data } = await supabaseAdmin.from("settings").select("*").eq("id", 1).maybeSingle();
  return {
    default_daily_limit: data?.default_daily_limit ?? 50,
    max_file_mb: data?.max_file_mb ?? 2000,
    parallel_jobs: data?.parallel_jobs ?? 3,
    allow_all_users: data?.allow_all_users ?? true,
    welcome_text: data?.welcome_text ?? null,
  };
}

type JobRow = {
  id: string;
  chat_id: number;
  telegram_id: number;
  url: string;
  title: string | null;
  kind: string;
  attempts: number;
  status_message_id: number | null;
  batch_id: string | null;
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
    throw new Error(`File is ${humanSize(declared)} — Telegram allows up to ${humanSize(maxBytes)}`);
  }

  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `File is ${humanSize(buffer.byteLength)} — Telegram allows up to ${humanSize(maxBytes)}`,
    );
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

type JobUpdate = Parameters<ReturnType<typeof supabaseAdmin.from<"jobs">>["update"]>[0];

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

export async function processJob(job: JobRow, settings: Settings): Promise<void> {
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
      const fileName = fileNameFromUrl(job.url, "video").replace(/\.m3u8$/i, "") + ".mp4";
      await setStatus(`🎬 Building video from stream…\n<code>${escapeHtml(fileName)}</code>`);
      const { bytes, truncated } = await hlsToMp4(job.url);
      if (!bytes.byteLength) throw new Error("Stream produced no video data");

      const form = new FormData();
      form.append("chat_id", String(job.chat_id));
      form.append("caption", captionFor(job, fileName));
      form.append("parse_mode", "HTML");
      form.append("supports_streaming", "true");
      form.append("video", new Blob([bytes as unknown as BlobPart], { type: "video/mp4" }), fileName);
      const sent = await tgUpload("sendVideo", form);
      if (!sent.ok) throw new Error(sent.error);

      if (truncated) {
        await sendMessage(
          job.chat_id,
          "⚠️ Stream bada tha, sirf pehla hissa bheja gaya (Telegram 50MB limit).",
        );
      }
      await finish(job, {
        file_name: fileName,
        file_size: bytes.byteLength,
        method: "hls",
        ms: Date.now() - startedAt,
      });
      if (statusId) await editMessage(job.chat_id, statusId, `✅ Sent: <code>${escapeHtml(fileName)}</code>`);
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
    await updateJob(job.id, {
      status: "failed",
      error: message.slice(0, 500),
      finished_at: new Date().toISOString(),
      ms_taken: Date.now() - startedAt,
      progress: 0,
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

const JOB_FIELDS = "id, chat_id, telegram_id, url, title, kind, attempts, status_message_id, batch_id";

/** Claims and runs queued jobs until the time budget runs out. */
export async function runQueue(budgetMs = 40_000): Promise<{ processed: number; remaining: number }> {
  const settings = await getSettings();
  const deadline = Date.now() + budgetMs;
  let processed = 0;

  while (Date.now() < deadline) {
    const { data: queued } = await supabaseAdmin
      .from("jobs")
      .select(JOB_FIELDS)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .order("position", { ascending: true })
      .limit(Math.max(1, settings.parallel_jobs));

    if (!queued?.length) break;

    const claimed: JobRow[] = [];
    for (const job of queued as JobRow[]) {
      const { data } = await supabaseAdmin
        .from("jobs")
        .update({ status: "claimed" })
        .eq("id", job.id)
        .eq("status", "queued")
        .select("id");
      if (data?.length) claimed.push(job);
    }
    if (!claimed.length) break;

    await Promise.all(claimed.map((job) => processJob(job, settings)));
    processed += claimed.length;
  }

  const { count } = await supabaseAdmin
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");

  return { processed, remaining: count ?? 0 };
}
