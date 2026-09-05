import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getBotSettings as getBotSettingsFn, saveBotSettings as saveBotSettingsFn } from "@/lib/dashboard.functions";
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
