import { createFileRoute } from "@tanstack/react-router";
import { runQueue } from "@/lib/uploader.server";

/** Drains any leftover queued jobs. Safe to call repeatedly. */
export const Route = createFileRoute("/api/public/telegram/tick")({
  server: {
    handlers: {
      GET: async () => Response.json(await runQueue(35_000)),
      POST: async () => Response.json(await runQueue(35_000)),
    },
  },
});
