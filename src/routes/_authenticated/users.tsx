import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { listUsers, updateBotUser } from "@/lib/dashboard.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/users")({
  head: () => ({
    meta: [
      { title: "Users — Marco Uploader" },
      { name: "description", content: "Manage bot users and daily limits." },
      { property: "og:title", content: "Users — Marco Uploader" },
      { property: "og:description", content: "Manage bot users and daily limits." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: UsersPage,
});

function UsersPage() {
  const listUsers = useServerFn(listUsersFn);
  const updateBotUser = useServerFn(updateBotUserFn);
  const [users, setUsers] = useState<Awaited<ReturnType<typeof listUsersFn>>>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const data = await listUsers();
    setUsers(data);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const setLimit = async (telegram_id: number, value: string) => {
    const num = value === "" ? null : Number(value);
    try {
      await updateBotUser({ telegram_id, daily_limit: num });
      toast.success("Limit update ho gaya");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update fail");
    }
  };

  const toggleBlock = async (telegram_id: number, blocked: boolean) => {
    try {
      await updateBotUser({ telegram_id, blocked });
      toast.success(blocked ? "User block ho gaya" : "User unblock ho gaya");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update fail");
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Users</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Bot users</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground">Abhi koi user nahi.</p>
          ) : (
            <div className="space-y-3">
              {users.map((u) => (
                <div
                  key={u.telegram_id}
                  className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      {u.first_name || "User"} {u.last_name || ""}
                      {u.username && <span className="text-muted-foreground"> (@{u.username})</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ID: {u.telegram_id} • Today: {u.used_today} / {u.daily_limit ?? "∞"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Last seen: {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : "—"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="number"
                      placeholder="Limit"
                      defaultValue={u.daily_limit ?? ""}
                      onBlur={(e) => setLimit(u.telegram_id, e.target.value)}
                      className="w-24"
                    />
                    <Button
                      size="sm"
                      variant={u.blocked ? "default" : "outline"}
                      onClick={() => toggleBlock(u.telegram_id, !u.blocked)}
                    >
                      {u.blocked ? "Unblock" : "Block"}
                    </Button>
                    {u.is_bot_admin && <Badge className="bg-primary/20 text-primary">Admin</Badge>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
