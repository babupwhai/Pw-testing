import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { detectKind, extractLinks, humanSize, isHttpUrl } from "@/lib/link-utils";
import { probeStream } from "@/lib/hls.server";
import {
  deleteMessage,
  downloadTelegramFile,
  editMessage,
  ensureCallbackQueries,
  sendMessage,
  tgCall,
} from "@/lib/telegram.server";
import { escapeHtml, getSettings, type Settings } from "@/lib/uploader.server";

export type TgUser = { id: number; first_name?: string; username?: string };
export type TgMessage = {
  message_id: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string };
};
export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
};
export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

function todayIST() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

export async function upsertUser(from: TgUser) {
  const { data: existing } = await supabaseAdmin
    .from("bot_users")
    .select("*")
    .eq("telegram_id", from.id)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from("bot_users")
      .update({
        last_seen_at: new Date().toISOString(),
        first_name: from.first_name ?? existing.first_name,
        username: from.username ?? existing.username,
      })
      .eq("telegram_id", from.id);
    return existing;
  }

  const { count } = await supabaseAdmin
    .from("bot_users")
    .select("id", { count: "exact", head: true });

  const { data: created } = await supabaseAdmin
    .from("bot_users")
    .insert({
      telegram_id: from.id,
      first_name: from.first_name ?? null,
      username: from.username ?? null,
      is_bot_admin: (count ?? 0) === 0,
    })
    .select("*")
    .single();

  return created!;
}

export async function usageToday(telegramId: number) {
  const { data } = await supabaseAdmin
    .from("usage_daily")
    .select("count")
    .eq("telegram_id", telegramId)
    .eq("day", todayIST())
    .maybeSingle();
  return data?.count ?? 0;
}

async function addUsage(telegramId: number, amount: number) {
  const current = await usageToday(telegramId);
  await supabaseAdmin
    .from("usage_daily")
    .upsert(
      { telegram_id: telegramId, day: todayIST(), count: current + amount },
      { onConflict: "telegram_id,day" },
    );
}

export function limitFor(user: { daily_limit: number | null }, settings: Settings) {
  return user.daily_limit ?? settings.default_daily_limit;
}

type BotUser = Awaited<ReturnType<typeof upsertUser>>;

/**
 * Shows every available quality with an estimated size and lets the user pick.
 * Returns false when the stream has only one rendition (then we just queue it).
 */
async function askQuality(
  chatId: number,
  user: BotUser,
  link: { url: string; title?: string },
): Promise<boolean> {
  const { data: active } = await supabaseAdmin
    .from("jobs")
    .select("id, status")
    .eq("telegram_id", user.telegram_id)
    .eq("url", link.url)
    .in("status", ["awaiting_quality", "queued", "claimed", "processing"])
    .limit(1)
    .maybeSingle();
  if (active) {
    await sendMessage(
      chatId,
      active.status === "awaiting_quality"
        ? "⚠️ Is lecture ka quality prompt already upar open hai."
        : "⏳ Ye lecture already download/upload ho raha hai. Live progress message upar update hoga.",
    );
    return true;
  }

  const callbackSetup = await ensureCallbackQueries();
  if (!callbackSetup.ok) {
    await sendMessage(chatId, `❌ Quality buttons activate nahi hue: ${escapeHtml(callbackSetup.error)}`);
    return true;
  }

  let info: Awaited<ReturnType<typeof probeStream>>;
  const probing = await sendMessage(chatId, "🔍 Stream check kar raha hoon (quality & size)…");
  const probeId = probing.ok ? probing.result.message_id : null;
  try {
    info = await probeStream(link.url);
  } catch (err) {
    if (probeId) {
      await editMessage(
        chatId,
        probeId,
        `❌ Stream khul nahi paya: ${escapeHtml((err instanceof Error ? err.message : String(err)).slice(0, 200))}`,
      );
    }
    return true;
  }

  if (info.variants.length < 2) {
    if (probeId) await deleteMessage(chatId, probeId);
    return false;
  }

  const variants = info.variants.slice(0, 8);
  const { data: job } = await supabaseAdmin
    .from("jobs")
    .insert({
      telegram_id: user.telegram_id,
      chat_id: chatId,
      url: link.url,
      title: link.title ?? null,
      kind: "hls",
      status: "awaiting_quality",
      status_message_id: probeId,
      variants,
    })
    .select("id")
    .single();

  if (!job) {
    if (probeId) await editMessage(chatId, probeId, "❌ Job banane me dikkat hui, dobara bhejo.");
    return true;
  }

  const mins = info.durationSec ? Math.round(info.durationSec / 60) : null;
  const lines = [
    "🎯 <b>Quality choose karo</b>",
    link.title ? escapeHtml(link.title) : "",
    mins ? `⏱ Length: ~${mins} min` : "",
    "",
    ...variants.map(
      (v, i) => `${i + 1}. <b>${escapeHtml(v.label)}</b> — ${v.estBytes ? `≈${humanSize(v.estBytes)}` : "size unknown"}`,
    ),
    "",
    "≈ size HLS segments se sampled estimate hai; exact MP4 size download ke baad dikhega.",
    "Poora lecture ek MP4 me aayega. Duration verify hogi aur SHA-256 hash bhi milega.",
  ].filter(Boolean);

  const keyboard = variants.map((v, i) => [
    {
      text: `${v.label} • ${v.estBytes ? `≈${humanSize(v.estBytes)}` : "?"}`,
      callback_data: `q:${job.id}:${i}`,
    },
  ]);

  const text = lines.join("\n");
  if (probeId) {
    await tgCall("editMessageText", {
      chat_id: chatId,
      message_id: probeId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
  } else {
    await tgCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
  }
  return true;
}

export async function handleCallback(cb: TgCallbackQuery): Promise<void> {
  const answer = (text = "") =>
    tgCall("answerCallbackQuery", { callback_query_id: cb.id, text });
  const data = cb.data ?? "";

  if (data.startsWith("p:")) {
    const { handlePwCallback } = await import("@/lib/pwflow.server");
    await handlePwCallback(
      cb.message?.chat.id ?? cb.from.id,
      cb.message?.message_id ?? null,
      cb.from.id,
      data,
      answer,
    );
    return;
  }

  const parts = data.split(":");
  if (parts[0] !== "q" || !parts[1]) {
    await answer("");
    return;
  }
  const jobId = parts[1];
  const index = Number(parts[2] ?? 0);

  const { data: job } = await supabaseAdmin
    .from("jobs")
    .select("id, telegram_id, chat_id, variants, status, status_message_id, title")
    .eq("id", jobId)
    .maybeSingle();

  if (!job || job.telegram_id !== cb.from.id) {
    await answer("Ye choice aapki nahi hai.");
    return;
  }
  if (job.status !== "awaiting_quality") {
    await answer("Ye already start ho chuka hai.");
    return;
  }

  const variants = (job.variants ?? []) as { url: string; label: string; estBytes: number | null }[];
  const picked = variants[index];
  if (!picked) {
    await answer("Quality mil nahi rahi.");
    return;
  }

  await answer("Selection save ho rahi hai…");
  const { error: selectionError } = await supabaseAdmin
    .from("jobs")
    .update({
      status: "queued",
      stream_url: picked.url,
      selected_quality: picked.label,
      segment_cursor: 0,
      part_index: 0,
      parts_sent: 0,
    })
    .eq("id", job.id)
    .eq("status", "awaiting_quality");
  if (selectionError) {
    console.error("quality selection failed", selectionError);
    await editMessage(
      job.chat_id,
      job.status_message_id ?? cb.message?.message_id ?? 0,
      "❌ Selection save nahi hui. Dobara lecture bhejo.",
    );
    return;
  }

  const { data: queued } = await supabaseAdmin
    .from("jobs")
    .select("status")
    .eq("id", job.id)
    .maybeSingle();
  if (queued?.status !== "queued") {
    await answer("Selection save nahi hui. Dobara link bhejo.");
    return;
  }

  if (job.status_message_id) {
    await editMessage(
      job.chat_id,
      job.status_message_id,
      `⏬ <b>${escapeHtml(picked.label)}</b> download shuru${picked.estBytes ? ` (~${humanSize(picked.estBytes)})` : ""}…`,
    );
  }
}

async function queueLinks(
  chatId: number,
  user: BotUser,
  settings: Settings,
  links: { url: string; title?: string }[],
  batchName?: string,
) {
  const limit = limitFor(user, settings);
  const used = await usageToday(user.telegram_id);
  const left = Math.max(0, limit - used);

  if (left <= 0) {
    await sendMessage(
      chatId,
      `🚫 Aaj ki limit (${limit}) khatam ho gayi. Kal (12 AM IST) phir se try karo.`,
    );
    return;
  }

  const accepted = links.slice(0, left);
  const skipped = links.length - accepted.length;

  // Single stream link → pehle quality + size dikhao, user chune.
  if (accepted.length === 1 && detectKind(accepted[0]!.url) === "hls") {
    const asked = await askQuality(chatId, user, accepted[0]!);
    if (asked) {
      await addUsage(user.telegram_id, 1);
      await supabaseAdmin
        .from("bot_users")
        .update({ total_jobs: user.total_jobs + 1 })
        .eq("telegram_id", user.telegram_id);
      return;
    }
  }


  let batchId: string | null = null;
  if (accepted.length > 1) {
    const { data: batch } = await supabaseAdmin
      .from("batches")
      .insert({
        telegram_id: user.telegram_id,
        chat_id: chatId,
        source_name: batchName ?? null,
        total: accepted.length,
      })
      .select("id")
      .single();
    batchId = batch?.id ?? null;
  }

  const statusIds: (number | null)[] = [];
  if (accepted.length === 1) {
    const ack = await sendMessage(chatId, "⚡ Processing your link…");
    statusIds.push(ack.ok ? ack.result.message_id : null);
  } else {
    await sendMessage(
      chatId,
      `📦 <b>${accepted.length}</b> links queued${skipped ? ` (${skipped} skipped — daily limit)` : ""}. Files order me aayenge.`,
    );
  }

  const rows = accepted.map((link, index) => ({
    telegram_id: user.telegram_id,
    chat_id: chatId,
    url: link.url,
    title: link.title ?? null,
    kind: detectKind(link.url),
    batch_id: batchId,
    position: index,
    status: "queued",
    status_message_id: statusIds[index] ?? null,
  }));

  await supabaseAdmin.from("jobs").insert(rows);
  await addUsage(user.telegram_id, accepted.length);
  await supabaseAdmin
    .from("bot_users")
    .update({ total_jobs: user.total_jobs + accepted.length })
    .eq("telegram_id", user.telegram_id);

  if (skipped > 0 && accepted.length === 1) {
    await sendMessage(chatId, `⚠️ ${skipped} links skip hue — aaj ki limit ${limit} hai.`);
  }
}

/** Queues links for a Telegram user (used by the batch browser). */
export async function queueForUser(
  chatId: number,
  telegramId: number,
  links: { url: string; title?: string }[],
  batchName?: string,
) {
  const settings = await getSettings();
  const { data: user } = await supabaseAdmin
    .from("bot_users")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (!user) return;
  await queueLinks(chatId, user as BotUser, settings, links, batchName);
}

async function handleCommand(
  text: string,
  message: TgMessage,
  user: BotUser,
  settings: Settings,
): Promise<boolean> {
  const chatId = message.chat.id;
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = (rawCmd ?? "").split("@")[0]!.toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    const limit = limitFor(user, settings);
    const used = await usageToday(user.telegram_id);
    await sendMessage(
      chatId,
      settings.welcome_text
        ? escapeHtml(settings.welcome_text)
        : [
            "👋 <b>Uploader bot ready</b>",
            "",
            "1️⃣ <b>Batch ka naam</b> ya <b>batch ID</b> bhejo — subjects, chapters aur lectures yahi khulenge, lecture par tap karo aur video aa jayega.",
            "2️⃣ Koi bhi <b>link</b> bhejo — mp4, pdf, zip, m3u8 — main file yahi bhej dunga.",
            "3️⃣ Ek <code>.txt</code> file bhejo jisme links hain — sab line by line aa jayenge.",
            "",
            `Aaj: <b>${used}/${limit}</b> uploads.`,
          ].join("\n"),
    );
    return true;
  }

  if (cmd === "/status") {
    const { data } = await supabaseAdmin
      .from("jobs")
      .select("status, url")
      .eq("telegram_id", user.telegram_id)
      .in("status", ["queued", "claimed", "processing"])
      .limit(10);
    await sendMessage(
      chatId,
      data?.length
        ? `⏳ ${data.length} pending:\n${data.map((j) => `• ${escapeHtml(j.url.slice(0, 60))}`).join("\n")}`
        : "✅ Kuch pending nahi hai.",
    );
    return true;
  }

  if (cmd === "/cancel") {
    const { data } = await supabaseAdmin
      .from("jobs")
      .update({ status: "cancelled" })
      .eq("telegram_id", user.telegram_id)
      .eq("status", "queued")
      .select("id");
    await sendMessage(chatId, `🛑 ${data?.length ?? 0} pending links cancel ho gaye.`);
    return true;
  }

  if (cmd === "/stats" && user.is_bot_admin) {
    const [{ count: users }, { count: done }, { count: failed }, { count: pending }] =
      await Promise.all([
        supabaseAdmin.from("bot_users").select("id", { count: "exact", head: true }),
        supabaseAdmin.from("jobs").select("id", { count: "exact", head: true }).eq("status", "done"),
        supabaseAdmin.from("jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
        supabaseAdmin
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .in("status", ["queued", "claimed", "processing"]),
      ]);
    await sendMessage(
      chatId,
      `👥 Users: <b>${users ?? 0}</b>\n✅ Sent: <b>${done ?? 0}</b>\n❌ Failed: <b>${failed ?? 0}</b>\n⏳ Pending: <b>${pending ?? 0}</b>`,
    );
    return true;
  }

  if (cmd === "/limit" && user.is_bot_admin) {
    const target = Number(args[0]);
    const value = Number(args[1]);
    if (!target || Number.isNaN(value)) {
      await sendMessage(chatId, "Usage: <code>/limit &lt;telegram_id&gt; &lt;number&gt;</code>");
      return true;
    }
    await supabaseAdmin
      .from("bot_users")
      .update({ daily_limit: value })
      .eq("telegram_id", target);
    await sendMessage(chatId, `✅ Daily limit for <code>${target}</code> set to <b>${value}</b>.`);
    return true;
  }

  if ((cmd === "/block" || cmd === "/unblock") && user.is_bot_admin) {
    const target = Number(args[0]);
    if (!target) {
      await sendMessage(chatId, `Usage: <code>${cmd} &lt;telegram_id&gt;</code>`);
      return true;
    }
    await supabaseAdmin
      .from("bot_users")
      .update({ blocked: cmd === "/block" })
      .eq("telegram_id", target);
    await sendMessage(chatId, `✅ <code>${target}</code> ${cmd === "/block" ? "blocked" : "unblocked"}.`);
    return true;
  }

  if (cmd.startsWith("/")) {
    await sendMessage(chatId, "❓ Aisa command nahi hai. /help dekho.");
    return true;
  }

  return false;
}

export async function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    await upsertUser(update.callback_query.from);
    await handleCallback(update.callback_query);
    return;
  }
  const message = update.message ?? update.edited_message;
  if (!message?.chat?.id || !message.from) return;

  const chatId = message.chat.id;
  const settings = await getSettings();
  const user = await upsertUser(message.from);

  if (user.blocked) {
    await sendMessage(chatId, "🚫 Aapka access band hai.");
    return;
  }

  const text = message.text ?? message.caption ?? "";
  if (text.trim().startsWith("/")) {
    const handled = await handleCommand(text, message, user, settings);
    if (handled) return;
  }

  // .txt file with a list of links
  if (message.document) {
    const name = message.document.file_name ?? "list.txt";
    const isText =
      /\.(txt|csv|log|m3u|list)$/i.test(name) || message.document.mime_type?.startsWith("text/");
    if (!isText) {
      await sendMessage(chatId, "📄 Sirf .txt (links wali) file bhejo, ya seedha link bhejo.");
      return;
    }
    const content = await downloadTelegramFile(message.document.file_id);
    if (!content) {
      await sendMessage(chatId, "❌ File padh nahi paya, dobara bhejo.");
      return;
    }
    const links = extractLinks(content);
    if (!links.length) {
      await sendMessage(chatId, "❌ Is file me koi link nahi mila.");
      return;
    }
    await queueLinks(chatId, user, settings, links, name);
    return;
  }

  const links = extractLinks(text).filter((l) => isHttpUrl(l.url));
  if (!links.length) {
    const query = text.trim();
    if (query.length >= 2) {
      const flow = await import("@/lib/pwflow.server");
      const callbacks = await ensureCallbackQueries();
      if (!callbacks.ok) {
        await sendMessage(chatId, `❌ Buttons activate nahi hue: ${escapeHtml(callbacks.error)}`);
        return;
      }
      if (flow.BATCH_ID_RE.test(query)) {
        await flow.showBatch(chatId, null, query);
      } else {
        await flow.showBatchSearch(chatId, query);
      }
      return;
    }
    await sendMessage(
      chatId,
      "🔗 Batch ka naam ya ID bhejo, ya koi link / links wali .txt file. /help dekho.",
    );
    return;
  }

  await queueLinks(chatId, user, settings, links);
}

export async function markUpdateSeen(updateId: number): Promise<boolean> {
  const { error } = await supabaseAdmin.from("tg_updates").insert({ update_id: updateId });
  return !error;
}

export async function keepChatAlive(chatId: number) {
  await tgCall("sendChatAction", { chat_id: chatId, action: "upload_video" });
}
