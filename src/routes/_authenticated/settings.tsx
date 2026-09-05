import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  connectBot as connectBotFn,
  disconnectBot as disconnectBotFn,
  getBotConnection as getBotConnectionFn,
  getBotSettings as getBotSettingsFn,
  saveBotSettings as saveBotSettingsFn,
  sendTestMessage as sendTestMessageFn,
} from "@/lib/dashboard.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Marco Uploader" },
      { name: "description", content: "Bot settings and daily limits." },
      { property: "og:title", content: "Settings — Marco Uploader" },
      { property: "og:description", content: "Bot settings and daily limits." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const [settings, setSettings] = useState<NonNullable<Awaited<ReturnType<typeof getBotSettingsFn>>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  type Connection = Awaited<ReturnType<typeof getBotConnectionFn>>;
  const [conn, setConn] = useState<Connection | null>(null);
  const [token, setToken] = useState("");
  const [hookUrl, setHookUrl] = useState("");
  const [testChat, setTestChat] = useState("");
  const [busy, setBusy] = useState(false);

  const loadConn = async () => {
    const data = await getBotConnectionFn();
    setConn(data);
    setHookUrl(data.webhook_url);
  };

  useEffect(() => {
    loadConn().catch(() => undefined);
  }, []);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await connectBotFn({
        data: hookUrl ? { token, webhook_url: hookUrl } : { token },
      });
      toast.success(`Connected: @${res.username}`);
      setToken("");
      await loadConn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Connect fail hua");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await disconnectBotFn();
      toast.success("Bot disconnect ho gaya");
      await loadConn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Disconnect fail");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await sendTestMessageFn({ data: { chat_id: Number(testChat) } });
      toast.success("Test message bhej diya");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test fail");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    getBotSettingsFn()
      .then((data) => setSettings(data))
      .finally(() => setLoading(false));
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      await saveBotSettingsFn({
        data: {
          default_daily_limit: settings.default_daily_limit,
          parallel_jobs: settings.parallel_jobs,
          allow_all_users: settings.allow_all_users,
          welcome_text: settings.welcome_text,
          max_part_mb: settings.max_part_mb ?? 45,
        },
      });
      toast.success("Settings save ho gayi");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save fail");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Telegram bot connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
            {conn?.connected ? (
              <div className="space-y-1">
                <p className="font-medium text-primary">
                  Connected{conn.username ? ` — @${conn.username}` : ""}
                </p>
                <p className="text-muted-foreground">Token: {conn.token_hint}</p>
                <p className="text-muted-foreground break-all">
                  Webhook: {conn.webhook?.url || conn.webhook_url}
                </p>
                {conn.webhook?.pending_update_count ? (
                  <p className="text-muted-foreground">
                    Pending updates: {conn.webhook.pending_update_count}
                  </p>
                ) : null}
                {conn.webhook?.last_error_message ? (
                  <p className="text-destructive">Telegram error: {conn.webhook.last_error_message}</p>
                ) : null}
                {conn.error ? <p className="text-destructive">{conn.error}</p> : null}
              </div>
            ) : (
              <p className="text-muted-foreground">
                Bot connected nahi hai. BotFather se token lo aur niche paste karo.
              </p>
            )}
          </div>

          <form onSubmit={connect} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bot_token">Bot token (BotFather se)</Label>
              <Input
                id="bot_token"
                value={token}
                placeholder="123456789:AA..."
                autoComplete="off"
                onChange={(e) => setToken(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hook_url">Webhook URL</Label>
              <Input id="hook_url" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={busy}>
                {busy ? "Connecting…" : "Connect bot"}
              </Button>
              <Button type="button" variant="outline" onClick={loadConn} disabled={busy}>
                Refresh status
              </Button>
              {conn?.connected ? (
                <Button type="button" variant="outline" onClick={disconnect} disabled={busy}>
                  Disconnect
                </Button>
              ) : null}
            </div>
          </form>

          <div className="space-y-2">
            <Label htmlFor="test_chat">Test message (apna Telegram chat id)</Label>
            <div className="flex gap-3">
              <Input
                id="test_chat"
                value={testChat}
                placeholder="123456789"
                onChange={(e) => setTestChat(e.target.value)}
              />
              <Button type="button" variant="outline" onClick={test} disabled={busy || !testChat}>
                Send
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Bot configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="default_daily_limit">Default daily limit</Label>
              <Input
                id="default_daily_limit"
                type="number"
                min={0}
                value={settings.default_daily_limit}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, default_daily_limit: Number(e.target.value) } : s))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="parallel_jobs">Parallel jobs</Label>
              <Input
                id="parallel_jobs"
                type="number"
                min={1}
                max={10}
                value={settings.parallel_jobs}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, parallel_jobs: Number(e.target.value) } : s))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="max_part_mb">Video part size (MB)</Label>
              <Input
                id="max_part_mb"
                type="number"
                min={5}
                max={48}
                value={settings.max_part_mb ?? 45}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, max_part_mb: Number(e.target.value) } : s))
                }
              />
              <p className="text-xs text-muted-foreground">
                Abhi Lovable testing me bade lecture itne-itne MB ke playable parts me aayenge.
                Heroku/local Bot API mode jodne par 2 GB tak single-file delivery milegi.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Switch
                id="allow_all_users"
                checked={settings.allow_all_users}
                onCheckedChange={(checked) =>
                  setSettings((s) => (s ? { ...s, allow_all_users: checked } : s))
                }
              />
              <Label htmlFor="allow_all_users">Allow all users (no approval needed)</Label>
            </div>

            <div className="space-y-2">
              <Label htmlFor="welcome_text">Welcome message</Label>
              <Textarea
                id="welcome_text"
                rows={4}
                value={settings.welcome_text ?? ""}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, welcome_text: e.target.value || null } : s))
                }
              />
            </div>

            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
