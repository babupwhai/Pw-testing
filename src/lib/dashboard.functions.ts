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
  .inputValidator((input: { id: string }) => input)
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
  .inputValidator((input: { telegram_id: number; daily_limit?: number | null; blocked?: boolean }) => input)
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
  .inputValidator(
    (input: {
      default_daily_limit: number;
      parallel_jobs: number;
      allow_all_users: boolean;
      welcome_text: string | null;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("settings").update(data as never).eq("id", 1);
    return { ok: true };
  });
