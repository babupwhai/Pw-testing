import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { editMessage, sendMessage, tgUpload } from "@/lib/telegram.server";
import {
  batchDetails,
  listLectures,
  listNotes,
  listTopics,
  resolveStream,
  type Lecture,
} from "@/lib/pw.server";
import { escapeHtml } from "@/lib/uploader.server";

const MAX_FILE_BYTES = 18 * 1024 * 1024;
const STREAM_CONCURRENCY = 2;
const PROGRESS_EVERY_MS = 6_000;
const REQUEST_GAP_MS = 350;
const LEASE_SECONDS = 300;
const MAX_SUBJECTS = 80;
const MAX_TOPICS = 1_000;
const MAX_LINKS = 10_000;

type TxtJobRow = {
  id: string;
  chat_id: number;
  telegram_id: number;
  batch_id: string;
  batch_name: string;
  status_message_id: number | null;
  worker_id: string | null;
  sent_parts: number;
};

type DbError = { code?: string; message: string };
type DbResult<T> = PromiseLike<{ data: T | null; error: DbError | null }>;
type TxtQuery = DbResult<TxtJobRow[]> & {
  insert: (value: unknown) => TxtQuery;
  update: (value: unknown) => TxtQuery;
  select: (columns?: string) => TxtQuery;
  eq: (column: string, value: unknown) => TxtQuery;
  lt: (column: string, value: unknown) => TxtQuery;
  maybeSingle: () => DbResult<TxtJobRow>;
};

const table = () =>
  supabaseAdmin.from("pw_txt_jobs" as never) as unknown as TxtQuery;

function safeName(name: string) {
  return (
    name.replace(/[^\w\-. ]+/g, " ").replace(/\s+/g, " ").trim() || "batch"
  ).slice(0, 60);
}

function validUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withSiteRetry<T>(
  operation: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = /\b429\b|too many requests|rate limit/i.test(message);
      const delay = rateLimited
        ? Math.min(30_000, 2_000 * 2 ** attempt)
        : Math.min(8_000, 750 * 2 ** attempt);
      await wait(delay);
    }
  }
  throw lastError;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
) {
  const output = new Array<R>(items.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const current = index++;
        output[current] = await fn(items[current] as T);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

async function lectureLink(
  batchId: string,
  subjectId: string,
  lecture: Lecture,
) {
  const source = validUrl(lecture.url ?? "");
  if (source && /youtube\.com|youtu\.be/i.test(source)) return source;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const stream = await resolveStream({
        batchId,
        subjectId,
        videoId: lecture.id,
      });
      return stream ? validUrl(stream) : null;
    } catch {
      if (attempt < 3) await wait(Math.min(12_000, 1_500 * 2 ** attempt));
    }
  }
  return null;
}

export async function buildBatchTxt(
  batchId: string,
  onProgress: (text: string) => void,
) {
  const info = await withSiteRetry(() => batchDetails(batchId));
  if (info.subjects.length > MAX_SUBJECTS) {
    throw new Error("Batch me supported limit se zyada subjects hain.");
  }

  const lines = [`===== BATCH: ${info.name} =====`, ""];
  let chapterCount = 0;
  let linkCount = 0;

  for (const subject of info.subjects) {
    lines.push(`## SUBJECT: ${subject.name}`, "");
    const topics = await withSiteRetry(() => listTopics(batchId, subject.id));
    chapterCount += topics.length;
    if (chapterCount > MAX_TOPICS) {
      throw new Error("Batch me supported limit se zyada chapters hain.");
    }

    for (const topic of topics) {
      lines.push(`### CHAPTER: ${topic.name}`);
      const lectures = await withSiteRetry(() =>
        listLectures(batchId, subject.id, topic.id),
      );
      await wait(REQUEST_GAP_MS);
      const notes = await withSiteRetry(() =>
        listNotes(batchId, subject.id, topic.id, "notes"),
      );
      await wait(REQUEST_GAP_MS);
      const dpp = await withSiteRetry(() =>
        listNotes(batchId, subject.id, topic.id, "DppNotes"),
      );
      const lectureLinks = await mapLimit(
        lectures,
        STREAM_CONCURRENCY,
        (lecture) => lectureLink(batchId, subject.id, lecture),
      );

      lectures.forEach((lecture, index) => {
        lines.push(
          `[Lecture] ${lecture.name}${lecture.duration ? ` (${lecture.duration})` : ""}`,
        );
        const link = lectureLinks[index];
        lines.push(link ?? "# link unavailable");
        if (link) linkCount++;
      });

      for (const note of [...notes, ...dpp]) {
        const link = validUrl(note.url);
        lines.push(`[Notes] ${note.name}`, link ?? "# link unavailable");
        if (link) linkCount++;
      }
      if (linkCount > MAX_LINKS) {
        throw new Error("Batch export me supported limit se zyada links hain.");
      }
      lines.push("");
      onProgress(
        `⏳ File ban rahi hai…\n📚 ${escapeHtml(info.name)}\n📂 Chapters: <b>${chapterCount}</b>\n🔗 Links: <b>${linkCount}</b>`,
      );
      await wait(REQUEST_GAP_MS);
    }
  }

  lines.push(`# Total links: ${linkCount}`);
  return { name: safeName(info.name), body: lines.join("\n") };
}

function splitUtf8Chunk(value: string, maxBytes: number) {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    if (encoder.encode(current + character).length > maxBytes) {
      if (current) chunks.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitBody(body: string) {
  const encoder = new TextEncoder();
  if (encoder.encode(body).length <= MAX_FILE_BYTES) return [body];

  const parts: string[] = [];
  let current = "";
  for (const sourceLine of body.split("\n")) {
    const lineChunks = splitUtf8Chunk(`${sourceLine}\n`, MAX_FILE_BYTES);
    for (const chunk of lineChunks) {
      if (encoder.encode(current + chunk).length > MAX_FILE_BYTES) {
        if (current) parts.push(current);
        current = chunk;
      } else {
        current += chunk;
      }
    }
  }
  if (current) parts.push(current);
  return parts;
}

async function sendTxt(
  chatId: number,
  fileName: string,
  body: string,
  caption: string,
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("document", new Blob([body], { type: "text/plain" }), fileName);
  return tgUpload("sendDocument", form);
}

export async function enqueueBatchTxt(
  chatId: number,
  telegramId: number,
  batchId: string,
  batchName: string,
) {
  if (!batchId || batchId.length > 100) throw new Error("Invalid batch");
  const status = await sendMessage(
    chatId,
    `⏳ <b>${escapeHtml(batchName)}</b> ka text file ban raha hai…\nBada batch ho to thoda time lagega, file yahin aa jayegi.`,
  );
  const messageId = status.ok ? status.result.message_id : null;
  const { error } = await table().insert({
    chat_id: chatId,
    telegram_id: telegramId,
    batch_id: batchId,
    batch_name: batchName.slice(0, 200),
    status: "queued",
    status_message_id: messageId,
  });

  if (error?.code === "23505") {
    if (messageId) {
      await editMessage(
        chatId,
        messageId,
        `⏳ <b>${escapeHtml(batchName)}</b> ka export pehle se queue me hai.`,
      );
    }
    return;
  }
  if (error) {
    if (messageId) {
      await editMessage(
        chatId,
        messageId,
        "❌ Export queue available nahi hai. Database migration check karo.",
      );
    }
    throw new Error("Batch export queue unavailable");
  }
  startTxtWorkerInBackground();
}

async function claimNext(workerId: string): Promise<TxtJobRow | null> {
  const client = supabaseAdmin as unknown as {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => DbResult<TxtJobRow[]>;
  };
  const { data, error } = await client.rpc("claim_pw_txt_job", {
    p_worker_id: workerId,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error(`Text queue claim failed: ${error.message}`);
  return data?.[0] ?? null;
}

async function updateOwnedJob(
  job: TxtJobRow,
  workerId: string,
  patch: Record<string, unknown>,
) {
  const { error } = await table()
    .update(patch)
    .eq("id", job.id)
    .eq("worker_id", workerId);
  if (error) throw new Error(`Text queue update failed: ${error.message}`);
}

async function runJob(job: TxtJobRow, workerId: string) {
  let lastEdit = 0;
  let progressChain = Promise.resolve();
  const onProgress = (text: string) => {
    if (Date.now() - lastEdit < PROGRESS_EVERY_MS) return;
    lastEdit = Date.now();
    progressChain = progressChain
      .then(() =>
        updateOwnedJob(job, workerId, {
          lease_until: new Date(
            Date.now() + LEASE_SECONDS * 1_000,
          ).toISOString(),
        }),
      )
      .then(async () => {
        if (job.status_message_id) {
          await editMessage(job.chat_id, job.status_message_id, text);
        }
      })
      .catch((error) => console.error("[pw-txt] progress failed", error));
  };

  try {
    const { name, body } = await buildBatchTxt(job.batch_id, onProgress);
    await progressChain;
    const parts = splitBody(body);
    for (let index = job.sent_parts; index < parts.length; index++) {
      const fileName =
        parts.length > 1 ? `${name}-part${index + 1}.txt` : `${name}.txt`;
      const sent = await sendTxt(
        job.chat_id,
        fileName,
        parts[index] as string,
        `📥 <b>${escapeHtml(job.batch_name)}</b> ka batch text file${parts.length > 1 ? ` (part ${index + 1}/${parts.length})` : ""}`,
      );
      if (!sent.ok) throw new Error(sent.error);
      await updateOwnedJob(job, workerId, {
        sent_parts: index + 1,
        lease_until: new Date(Date.now() + LEASE_SECONDS * 1_000).toISOString(),
      });
    }
    await updateOwnedJob(job, workerId, {
      status: "done",
      finished_at: new Date().toISOString(),
      lease_until: null,
      worker_id: null,
      last_error: null,
    });
    if (job.status_message_id) {
      await editMessage(
        job.chat_id,
        job.status_message_id,
        `✅ <b>${escapeHtml(job.batch_name)}</b> ka text file taiyar hai.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await updateOwnedJob(job, workerId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      lease_until: null,
      worker_id: null,
      last_error: message.slice(0, 300),
    }).catch((updateError) =>
      console.error("[pw-txt] failed status update", updateError),
    );
    await sendMessage(
      job.chat_id,
      "❌ Text file nahi ban paayi. Dobara try karo ya admin logs check karo.",
    );
  }
}

let worker: Promise<void> | null = null;

async function drain() {
  const workerId = randomUUID();
  for (let processed = 0; processed < 5; processed++) {
    const job = await claimNext(workerId);
    if (!job) return;
    await runJob(job, workerId);
  }
}

export function startTxtWorkerInBackground() {
  if (worker) return false;
  worker = drain()
    .catch((error) => console.error("[pw-txt] worker failed", error))
    .finally(() => {
      worker = null;
    });
  return true;
}

export async function recoverInterruptedTxtJobs() {
  const { error } = await table()
    .update({
      status: "queued",
      worker_id: null,
      lease_until: null,
      started_at: null,
    })
    .eq("status", "processing")
    .lt("lease_until", new Date().toISOString());
  if (error) console.error("[pw-txt] stale recovery failed", error.message);
}