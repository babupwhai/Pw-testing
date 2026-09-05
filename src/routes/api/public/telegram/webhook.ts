import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { handleUpdate, markUpdateSeen, type TgUpdate } from "@/lib/bot.server";
import { runQueue } from "@/lib/uploader.server";

function expectedSecret(apiKey: string) {
  return createHash("sha256").update(`telegram-webhook:${apiKey}`).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env["TELEGRAM_API_KEY"];
        if (!apiKey) return new Response("Not configured", { status: 500 });

        const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
        if (!safeEqual(provided, expectedSecret(apiKey))) {
          return new Response("Unauthorized", { status: 401 });
        }

        let update: TgUpdate;
        try {
          update = (await request.json()) as TgUpdate;
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        if (typeof update.update_id !== "number") return Response.json({ ok: true });

        const fresh = await markUpdateSeen(update.update_id);
        if (!fresh) return Response.json({ ok: true, duplicate: true });

        try {
          await handleUpdate(update);
          await runQueue(35_000);
        } catch (err) {
          console.error("telegram webhook error", err);
        }

        return Response.json({ ok: true });
      },
    },
  },
});
