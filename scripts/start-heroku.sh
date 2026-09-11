#!/usr/bin/env bash
set -euo pipefail

: "${TELEGRAM_API_ID:?TELEGRAM_API_ID is required}"
: "${TELEGRAM_API_HASH:?TELEGRAM_API_HASH is required}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"

binary="${TELEGRAM_BOT_API_BINARY:-$PWD/vendor/telegram-bot-api}"
if [[ ! -x "$binary" ]]; then
  echo "telegram-bot-api binary is missing or not executable" >&2
  exit 1
fi

export TELEGRAM_LOCAL_API_BASE="${TELEGRAM_LOCAL_API_BASE:-http://127.0.0.1:8081}"
work_dir="/tmp/telegram-bot-api"
temp_dir="/tmp/telegram-bot-api-temp"
mkdir -p "$work_dir" "$temp_dir"

# The official cloud Bot API must release the bot before a local Bot API server
# can own it. Repeating logOut on a later dyno restart is harmless.
node <<'NODE'
const token = process.env.TELEGRAM_BOT_TOKEN;
(async () => {
  try {
    await fetch(`https://api.telegram.org/bot${token}/logOut`, { method: "POST" });
  } catch {
    // It may already be logged out after a previous dyno cycle.
  }
})();
NODE

"$binary" \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --local \
  --http-port=8081 \
  --dir="$work_dir" \
  --temp-dir="$temp_dir" \
  >/tmp/telegram-bot-api.log 2>&1 &
telegram_pid=$!

cleanup() {
  kill "$telegram_pid" "${app_pid:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

node <<'NODE'
const token = process.env.TELEGRAM_BOT_TOKEN;
const base = process.env.TELEGRAM_LOCAL_API_BASE;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch(`${base}/bot${token}/getMe`, { method: "POST" });
    const body = await response.json();
    if (body.ok) process.exit(0);
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.error("Local Telegram Bot API server did not become ready");
process.exit(1);
NODE

node .output/server/index.mjs &
app_pid=$!
wait "$app_pid"