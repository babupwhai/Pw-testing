import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { handleUpdate, markUpdateSeen, type TgUpdate } from "@/lib/bot.server";
import { getBotToken, webhookSecretFor } from "@/lib/telegram.server";
import { runQueue } from "@/lib/uploader.server";

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function allowedSecrets(): Promise<string[]> {
  const secrets: string[] = [];
  const token = await getBotToken();
  if (token) secrets.push(webhookSecretFor(token));
  const connectionKey = process.env["TELEGRAM_API_KEY"];
  if (connectionKey) {
    secrets.push(
      createHash("sha256").update(`telegram-webhook:${connectionKey}`).digest("base64url"),
    );
  }
  return secrets;
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secrets = await allowedSecrets();
        if (!secrets.length) return new Response("Not configured", { status: 500 });

        const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
        if (!secrets.some((s) => safeEqual(provided, s))) {
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
