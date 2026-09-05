import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { runQueue } from "@/lib/uploader.server";
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
        return Response.json(await runQueue(35_000));
      },
    },
  },
});
