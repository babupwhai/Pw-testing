import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getOverview, retryJob } from "@/lib/dashboard.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Marco Uploader" },
      { name: "description", content: "Bot overview, recent jobs and stats." },
      { property: "og:title", content: "Dashboard — Marco Uploader" },
      { property: "og:description", content: "Bot overview, recent jobs and stats." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getOverview>> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOverview()
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  const onRetry = async (id: string) => {
    try {
      await retryJob({ id });
      toast.success("Job retry ho gaya");
      const refreshed = await getOverview();
      setData(refreshed);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry fail");
    }
  };

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const stats = [
    { label: "Users", value: data.users },
    { label: "Total jobs", value: data.total },
    { label: "Done", value: data.done },
    { label: "Failed", value: data.failed },
    { label: "Pending", value: data.pending },
  ];

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      done: "bg-success text-success-foreground",
      failed: "bg-destructive text-destructive-foreground",
      queued: "bg-secondary text-secondary-foreground",
      claimed: "bg-warning text-warning-foreground",
      processing: "bg-primary/20 text-primary",
    };
    return <Badge className={map[status] ?? "bg-muted"}>{status}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Overview</h1>
        <Link to="/jobs">
          <Button variant="outline" size="sm">All jobs</Button>
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">Abhi koi job nahi.</p>
          ) : (
            <div className="space-y-3">
              {data.recent.map((job) => (
                <div
                  key={job.id}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{job.title || job.file_name || job.url}</p>
                    <p className="text-xs text-muted-foreground">
                      {job.kind} • {new Date(job.created_at).toLocaleString()}
                    </p>
                    {job.error && <p className="mt-1 text-xs text-destructive">{job.error}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(job.status)}
                    {job.status === "failed" && (
                      <Button size="sm" variant="outline" onClick={() => onRetry(job.id)}>
                        Retry
                      </Button>
                    )}
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
