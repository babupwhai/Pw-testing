import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { detectKind, extractLinks, isHttpUrl } from "@/lib/link-utils";
import { downloadTelegramFile, sendMessage, tgCall } from "@/lib/telegram.server";
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
            "• Koi bhi link bhejo — mp4, pdf, zip, m3u8 — main file yahi bhej dunga.",
            "• Ek <code>.txt</code> file bhejo jisme links hain — sab line by line aa jayenge.",
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
    await sendMessage(chatId, "🔗 Ek link bhejo (ya links wali .txt file). /help for details.");
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
