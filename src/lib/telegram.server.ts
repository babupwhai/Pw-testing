const GATEWAY = "https://connector-gateway.lovable.dev/telegram";

function keys() {
  const lovable = process.env["LOVABLE_API_KEY"];
  const connection = process.env["TELEGRAM_API_KEY"];
  if (!lovable) throw new Error("LOVABLE_API_KEY is not configured");
  if (!connection) throw new Error("TELEGRAM_API_KEY is not configured");
  return { lovable, connection };
}

function authHeaders() {
  const { lovable, connection } = keys();
  return {
    Authorization: `Bearer ${lovable}`,
    "X-Connection-Api-Key": connection,
  };
}

export type TgResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

export async function tgCall<T = unknown>(
  method: string,
  body: Record<string, unknown> = {},
): Promise<TgResult<T>> {
  try {
    const res = await fetch(`${GATEWAY}/${method}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: { ok?: boolean; result?: T; description?: string } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return { ok: false, error: `Telegram ${method} [${res.status}]: ${text.slice(0, 300)}` };
    }
    if (!res.ok || parsed.ok !== true) {
      return {
        ok: false,
        error: `${parsed.description ?? text.slice(0, 300)} (${res.status})`,
      };
    }
    return { ok: true, result: parsed.result as T };
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
    const res = await fetch(`${GATEWAY}/${method}`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    const text = await res.text();
    let parsed: { ok?: boolean; result?: T; description?: string } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return { ok: false, error: `Telegram ${method} [${res.status}]: ${text.slice(0, 300)}` };
    }
    if (!res.ok || parsed.ok !== true) {
      return { ok: false, error: `${parsed.description ?? text.slice(0, 300)} (${res.status})` };
    }
    return { ok: true, result: parsed.result as T };
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
  return `${GATEWAY}/file/${info.result.file_path}`;
}

export async function downloadTelegramFile(fileId: string): Promise<string | null> {
  const link = await getFileLink(fileId);
  if (!link) return null;
  const res = await fetch(link, { headers: authHeaders() });
  if (!res.ok) return null;
  return res.text();
}
