import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (!data) throw new Error("You are not an admin of this bot yet.");
}

/** Grants admin to the first signed-in user; later users must be added by an admin. */
export const claimAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin
      .from("user_roles")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin");
    if ((count ?? 0) > 0) return { granted: false };
    await supabaseAdmin.from("user_roles").insert({ user_id: context.userId, role: "admin" });
    return { granted: true };
  });

export const isAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    return { admin: Boolean(data) };
  });

export const getOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const counts = async (status?: string[]) => {
      let q = supabaseAdmin.from("jobs").select("id", { count: "exact", head: true });
      if (status) q = q.in("status", status);
      return (await q).count ?? 0;
    };
    const [users, total, done, failed, pending, recent] = await Promise.all([
      supabaseAdmin.from("bot_users").select("id", { count: "exact", head: true }),
      counts(),
      counts(["done"]),
      counts(["failed"]),
      counts(["queued", "claimed", "processing"]),
      supabaseAdmin
        .from("jobs")
        .select("id, url, title, kind, status, file_name, file_size, ms_taken, created_at, error")
        .order("created_at", { ascending: false })
        .limit(12),
    ]);
    return {
      users: users.count ?? 0,
      total,
      done,
      failed,
      pending,
      recent: recent.data ?? [],
    };
  });

export const listJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: { status?: string } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = supabaseAdmin
      .from("jobs")
      .select(
        "id, telegram_id, url, title, kind, status, method, file_name, file_size, ms_taken, error, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (data.status && data.status !== "all") q = q.eq("status", data.status);
    const { data: jobs } = await q;
    return jobs ?? [];
  });

export const retryJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("jobs")
      .update({ status: "queued", error: null, progress: 0 })
      .eq("id", data.id);
    return { ok: true };
  });

export const listUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: users }, { data: usage }] = await Promise.all([
      supabaseAdmin
        .from("bot_users")
        .select("*")
        .order("last_seen_at", { ascending: false })
        .limit(200),
      supabaseAdmin
        .from("usage_daily")
        .select("telegram_id, count, day")
        .gte("day", new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)),
    ]);
    const today = new Map((usage ?? []).map((u) => [u.telegram_id, u.count]));
    return (users ?? []).map((u) => ({ ...u, used_today: today.get(u.telegram_id) ?? 0 }));
  });

export const updateBotUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { telegram_id: number; daily_limit?: number | null; blocked?: boolean }) => input)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch: Record<string, unknown> = {};
    if (data.daily_limit !== undefined) patch["daily_limit"] = data.daily_limit;
    if (data.blocked !== undefined) patch["blocked"] = data.blocked;
    await supabaseAdmin.from("bot_users").update(patch as never).eq("telegram_id", data.telegram_id);
    return { ok: true };
  });

export const getBotSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("settings").select("*").eq("id", 1).maybeSingle();
    return data;
  });

export const saveBotSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      default_daily_limit: number;
      parallel_jobs: number;
      allow_all_users: boolean;
      welcome_text: string | null;
      max_part_mb?: number;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("settings").update(data as never).eq("id", 1);
    return { ok: true };
  });

/** ---- Telegram bot connection (token pasted in the admin panel) ---- */

const DEFAULT_WEBHOOK_BASE = "https://link-to-streamer.lovable.app";

export const getBotConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { tgCall } = await import("@/lib/telegram.server");
    const { data } = await supabaseAdmin
      .from("settings")
      .select("bot_token, bot_username, webhook_url, webhook_set_at")
      .eq("id", 1)
      .maybeSingle();
    const row = (data ?? {}) as {
      bot_token?: string | null;
      bot_username?: string | null;
      webhook_url?: string | null;
      webhook_set_at?: string | null;
    };

    let me: string | null = null;
    let webhook: { url?: string; pending_update_count?: number; last_error_message?: string } | null =
      null;
    let error: string | null = null;

    if (row.bot_token) {
      const info = await tgCall<{ username: string }>("getMe");
      if (info.ok) me = info.result.username;
      else error = info.error;
      const hook = await tgCall<{
        url?: string;
        pending_update_count?: number;
        last_error_message?: string;
      }>("getWebhookInfo");
      if (hook.ok) webhook = hook.result;
    }

    return {
      connected: Boolean(row.bot_token),
      token_hint: row.bot_token ? `${row.bot_token.slice(0, 8)}…${row.bot_token.slice(-4)}` : null,
      username: me ?? row.bot_username ?? null,
      webhook_url: row.webhook_url ?? `${DEFAULT_WEBHOOK_BASE}/api/public/telegram/webhook`,
      webhook_set_at: row.webhook_set_at ?? null,
      webhook,
      error,
    };
  });

export const connectBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { token: string; webhook_url?: string }) => input)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { clearTelegramCache, tgCall, webhookSecretFor } = await import("@/lib/telegram.server");

    const token = data.token.trim();
    if (!/^\d+:[\w-]{20,}$/.test(token)) {
      throw new Error("Ye bot token sahi format me nahi hai (123456:ABC-DEF...).");
    }

    const check = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const checkJson = (await check.json()) as {
      ok?: boolean;
      result?: { username?: string };
      description?: string;
    };
    if (!checkJson.ok || !checkJson.result?.username) {
      throw new Error(`Telegram ne token reject kiya: ${checkJson.description ?? "invalid token"}`);
    }

    const webhookUrl =
      data.webhook_url?.trim() || `${DEFAULT_WEBHOOK_BASE}/api/public/telegram/webhook`;

    await supabaseAdmin
      .from("settings")
      .update({
        bot_token: token,
        bot_username: checkJson.result.username,
        webhook_url: webhookUrl,
        webhook_set_at: new Date().toISOString(),
      } as never)
      .eq("id", 1);
    clearTelegramCache();

    const hook = await tgCall("setWebhook", {
      url: webhookUrl,
      secret_token: webhookSecretFor(token),
      allowed_updates: ["message", "edited_message", "callback_query"],
      drop_pending_updates: true,
      max_connections: 40,
    });
    if (!hook.ok) throw new Error(`Webhook set nahi hua: ${hook.error}`);

    return { ok: true, username: checkJson.result.username, webhook_url: webhookUrl };
  });

export const disconnectBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { clearTelegramCache, tgCall } = await import("@/lib/telegram.server");
    await tgCall("deleteWebhook", { drop_pending_updates: false });
    await supabaseAdmin
      .from("settings")
      .update({ bot_token: null, bot_username: null, webhook_set_at: null } as never)
      .eq("id", 1);
    clearTelegramCache();
    return { ok: true };
  });

/** Sends a test message to the admin's own Telegram chat id. */
export const sendTestMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { chat_id: number }) => input)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { sendMessage } = await import("@/lib/telegram.server");
    const res = await sendMessage(data.chat_id, "✅ Test message — bot connected hai.");
    if (!res.ok) throw new Error(res.error);
    return { ok: true };
  });
