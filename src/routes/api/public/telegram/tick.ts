import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { recoverInterruptedJobs, startQueueInBackground } from "@/lib/uploader.server";
import { getBotToken } from "@/lib/telegram.server";

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function authorized(request: Request) {
  const token = await getBotToken();
  if (!token) return false;
  const expected = createHash("sha256").update(`telegram-queue:${token}`).digest("base64url");
  return safeEqual(request.headers.get("x-telegram-queue-secret") ?? "", expected);
}

/** Drains any leftover queued jobs. Safe to call repeatedly. */
export const Route = createFileRoute("/api/public/telegram/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await authorized(request))) return new Response("Unauthorized", { status: 401 });
        const { recoverInterruptedTxtJobs, startTxtWorkerInBackground } =
          await import("@/lib/pwtxt.server");
        if (request.headers.get("x-telegram-recover-interrupted") === "1") {
          await recoverInterruptedJobs();
          await recoverInterruptedTxtJobs();
        }
        const txtStarted = startTxtWorkerInBackground();
        return Response.json({
          ok: true,
          started: startQueueInBackground(),
          txtStarted,
        });
      },
    },
  },
});
