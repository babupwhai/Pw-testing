import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { listJobs, retryJob } from "@/lib/dashboard.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/jobs")({
  head: () => ({
    meta: [
      { title: "Jobs — Marco Uploader" },
      { name: "description", content: "All bot upload jobs with status filter." },
      { property: "og:title", content: "Jobs — Marco Uploader" },
      { property: "og:description", content: "All bot upload jobs with status filter." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: JobsPage,
});

function JobsPage() {
  const [status, setStatus] = useState<string>("all");
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof listJobs>>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listJobs({ data: { status } })
      .then(setJobs)
      .finally(() => setLoading(false));
  }, [status]);

  const onRetry = async (id: string) => {
    try {
      await retryJob({ data: { id } });
      toast.success("Job retry ho gaya");
      const refreshed = await listJobs({ data: { status } });
      setJobs(refreshed);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry fail");
    }
  };

  const statusBadge = (jobStatus: string) => {
    const map: Record<string, string> = {
      done: "bg-success text-success-foreground",
      failed: "bg-destructive text-destructive-foreground",
      queued: "bg-secondary text-secondary-foreground",
      claimed: "bg-warning text-warning-foreground",
      processing: "bg-primary/20 text-primary",
    };
    return <Badge className={map[jobStatus] ?? "bg-muted"}>{jobStatus}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Jobs</h1>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="claimed">Claimed</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent 100 jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Is filter me koi job nahi.</p>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{job.title || job.file_name || job.url}</p>
                    <p className="text-xs text-muted-foreground">
                      {job.kind} • {job.method} • user {job.telegram_id}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(job.created_at).toLocaleString()}
                      {job.ms_taken ? ` • ${(job.ms_taken / 1000).toFixed(1)}s` : ""}
                      {job.file_size ? ` • ${(job.file_size / 1024 / 1024).toFixed(1)} MB` : ""}
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
