import { createHash } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const GATEWAY = "https://connector-gateway.lovable.dev/telegram";

type Transport =
  | { mode: "token"; base: string; fileBase: string; headers: Record<string, string> }
  | { mode: "gateway"; base: string; fileBase: string; headers: Record<string, string> };

let cached: { transport: Transport; at: number } | null = null;
let callbacksEnsuredAt = 0;
const CACHE_MS = 15_000;

export async function getBotToken(): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("settings")
    .select("bot_token")
    .eq("id", 1)
    .maybeSingle();
  const token = (data as { bot_token?: string | null } | null)?.bot_token?.trim();
  return token ? token : process.env["TELEGRAM_BOT_TOKEN"]?.trim() || null;
}

/** Secret token Telegram sends back on every webhook call. */
export function webhookSecretFor(token: string) {
  return createHash("sha256").update(`telegram-webhook:${token}`).digest("base64url");
}

async function transport(): Promise<Transport> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.transport;

  const token = await getBotToken();
  let value: Transport;
  if (token) {
    const localBase = process.env["TELEGRAM_LOCAL_API_BASE"]?.replace(/\/+$/, "");
    const apiBase = localBase || "https://api.telegram.org";
    value = {
      mode: "token",
      base: `${apiBase}/bot${token}`,
      fileBase: `${apiBase}/file/bot${token}`,
      headers: {},
    };
  } else {
    const lovable = process.env["LOVABLE_API_KEY"];
    const connection = process.env["TELEGRAM_API_KEY"];
    if (!lovable || !connection) {
      throw new Error("Bot token not set. Admin panel → Settings me bot token daalo.");
    }
    value = {
      mode: "gateway",
      base: GATEWAY,
      fileBase: `${GATEWAY}/file`,
      headers: {
        Authorization: `Bearer ${lovable}`,
        "X-Connection-Api-Key": connection,
      },
    };
  }
  cached = { transport: value, at: Date.now() };
  return value;
}

export function clearTelegramCache() {
  cached = null;
  callbacksEnsuredAt = 0;
}

/** Keeps old bot connections subscribed to inline-button clicks after upgrades. */
export async function ensureCallbackQueries(): Promise<TgResult<true>> {
  if (Date.now() - callbacksEnsuredAt < 5 * 60_000) return { ok: true, result: true };

  const token = await getBotToken();
  if (!token) return { ok: false, error: "Bot token not set" };
  const { data } = await supabaseAdmin
    .from("settings")
    .select("webhook_url")
    .eq("id", 1)
    .maybeSingle();
  const webhookUrl = data?.webhook_url?.trim() || process.env["TELEGRAM_WEBHOOK_URL"]?.trim();
  if (!webhookUrl) return { ok: false, error: "Webhook URL not set" };

  const result = await tgCall("setWebhook", {
    url: webhookUrl,
    secret_token: webhookSecretFor(token),
    allowed_updates: ["message", "edited_message", "callback_query"],
    drop_pending_updates: false,
    max_connections: 40,
  });
  if (!result.ok) return result;
  callbacksEnsuredAt = Date.now();
  return { ok: true, result: true };
}

export type TgResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

function parseResponse<T>(status: number, text: string): TgResult<T> {
  let parsed: { ok?: boolean; result?: T; description?: string } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { ok: false, error: `Telegram [${status}]: ${text.slice(0, 300)}` };
  }
  if (parsed.ok !== true) {
    return { ok: false, error: `${parsed.description ?? text.slice(0, 300)} (${status})` };
  }
  return { ok: true, result: parsed.result as T };
}

export async function tgCall<T = unknown>(
  method: string,
  body: Record<string, unknown> = {},
): Promise<TgResult<T>> {
  try {
    const t = await transport();
    const res = await fetch(`${t.base}/${method}`, {
      method: "POST",
      headers: { ...t.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseResponse<T>(res.status, await res.text());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Multipart upload (used when Telegram cannot fetch the URL itself). */
export async function tgUpload<T = unknown>(
  method: string,
  form: FormData,
): Promise<TgResult<T>> {
  try {
    const t = await transport();
    const res = await fetch(`${t.base}/${method}`, {
      method: "POST",
      headers: t.headers,
      body: form,
    });
    return parseResponse<T>(res.status, await res.text());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendMessage(chatId: number, text: string) {
  return tgCall<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

export async function editMessage(chatId: number, messageId: number, text: string) {
  return tgCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

export async function deleteMessage(chatId: number, messageId: number) {
  return tgCall("deleteMessage", { chat_id: chatId, message_id: messageId });
}

export async function getFileLink(fileId: string): Promise<string | null> {
  const info = await tgCall<{ file_path: string }>("getFile", { file_id: fileId });
  if (!info.ok || !info.result?.file_path) return null;
  const t = await transport();
  return `${t.fileBase}/${info.result.file_path}`;
}

export async function downloadTelegramFile(fileId: string): Promise<string | null> {
  const link = await getFileLink(fileId);
  if (!link) return null;
  const t = await transport();
  const res = await fetch(link, { headers: t.headers });
  if (!res.ok) return null;
  return res.text();
}
