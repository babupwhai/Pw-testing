#!/usr/bin/env bash
set -euo pipefail

: "${TELEGRAM_API_ID:?TELEGRAM_API_ID is required}"
: "${TELEGRAM_API_HASH:?TELEGRAM_API_HASH is required}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${TELEGRAM_WEBHOOK_URL:?TELEGRAM_WEBHOOK_URL is required}"

binary="${TELEGRAM_BOT_API_BINARY:-$PWD/vendor/telegram-bot-api}"
if [[ ! -x "$binary" ]]; then
  echo "telegram-bot-api binary is missing or not executable" >&2
  exit 1
fi

export TELEGRAM_LOCAL_API_BASE="${TELEGRAM_LOCAL_API_BASE:-http://127.0.0.1:8081}"
work_dir="/tmp/telegram-bot-api"
temp_dir="/tmp/telegram-bot-api-temp"
mkdir -p "$work_dir" "$temp_dir"

"$binary" \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --local \
  --http-port=8081 \
  --dir="$work_dir" \
  --temp-dir="$temp_dir" \
  >/tmp/telegram-bot-api.log 2>&1 &
telegram_pid=$!

node .output/server/index.mjs &
app_pid=$!

cleanup() {
  kill "$telegram_pid" "${app_pid:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! node <<'NODE'
const token = process.env.TELEGRAM_BOT_TOKEN;
const base = process.env.TELEGRAM_LOCAL_API_BASE;
(async () => {
  let lastError = "no response";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let waitSeconds = 5;
    try {
      const response = await fetch(`${base}/bot${token}/getMe`, { method: "POST" });
      const body = await response.json();
      if (body.ok) process.exit(0);
      lastError = `${response.status} ${body.description || "unknown response"}`;
      if (response.status === 429) {
        const described = /retry after (\d+)/i.exec(body.description || "")?.[1];
        waitSeconds = Math.max(
          5,
          Number(body.parameters?.retry_after ?? described ?? 5) + 1,
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    console.error(`Local Telegram Bot API waiting ${waitSeconds}s: ${lastError}`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }
  console.error(`Local Telegram Bot API server did not become ready: ${lastError}`);
  process.exit(1);
})();
NODE
then
  echo "Local Telegram Bot API startup log:" >&2
  tail -100 /tmp/telegram-bot-api.log >&2 || true
  exit 1
fi

node <<'NODE'
const { createHash } = require("node:crypto");
const token = process.env.TELEGRAM_BOT_TOKEN;
const base = process.env.TELEGRAM_LOCAL_API_BASE;
const url = process.env.TELEGRAM_WEBHOOK_URL;
(async () => {
  const secret = createHash("sha256").update(`telegram-webhook:${token}`).digest("base64url");
  const response = await fetch(`${base}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secret,
      allowed_updates: ["message", "edited_message", "callback_query"],
      drop_pending_updates: false,
      max_connections: 40,
    }),
  });
  const body = await response.json();
  if (!body.ok) {
    console.error(`Local Telegram webhook setup failed: ${body.description || response.status}`);
    process.exit(1);
  }
  console.log("Local Telegram Bot API and webhook are ready");
})();
NODE

node <<'NODE'
const { createHash } = require("node:crypto");
const token = process.env.TELEGRAM_BOT_TOKEN;
const port = process.env.PORT;
(async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/auth`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const secret = createHash("sha256").update(`telegram-queue:${token}`).digest("base64url");
  const response = await fetch(`http://127.0.0.1:${port}/api/public/telegram/tick`, {
    method: "POST",
    headers: {
      "x-telegram-queue-secret": secret,
      "x-telegram-recover-interrupted": "1",
    },
  });
  if (!response.ok) {
    console.error(`Queue startup failed: HTTP ${response.status}`);
    process.exit(1);
  }
  console.log("Interrupted Telegram jobs recovered and queue started");
})();
NODE

wait "$app_pid"