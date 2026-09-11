#!/usr/bin/env bash
set -euo pipefail

version="2026-08-05"
expected_sha256="a225dbad45cc7f63822f18e5c0841331304f182b4efea4aab0fdd39e20d5c8ea"
url="https://github.com/jakbin/telegram-bot-api-binary/releases/download/${version}/telegram-bot-api"
target="vendor/telegram-bot-api"

mkdir -p vendor
curl --fail --silent --show-error --location "$url" --output "${target}.download"
echo "${expected_sha256}  ${target}.download" | sha256sum --check --status
mv "${target}.download" "$target"
chmod +x "$target"
"$target" --version