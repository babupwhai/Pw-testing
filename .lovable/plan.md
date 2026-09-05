# Telegram Uploader Bot (URL → Video/PDF) with Dashboard

## Kya banega

Ek Telegram bot jisko aap koi bhi link (mp4, m3u8/HLS, pdf, ya koi bhi file URL) ya links ki `.txt` file bhejenge, aur wo har link ko download/convert karke Telegram par video ya document ke roop me wapas bhej dega — line by line, isi order me. Saath me ek web dashboard jahan owner sab jobs, users aur daily limits control kar sake.

## Do hisse (kyunki is app ke server par ffmpeg nahi chal sakta)

```text
Telegram user
   │  link / .txt bhejta hai
   ▼
Lovable app (webhook + dashboard + database)
   │  job queue me daal deta hai, user ko "queued" reply
   ▼
Worker (aap Render/Heroku par host karenge — ffmpeg ke saath)
   │  job uthata hai → download / m3u8→mp4 convert → Telegram par upload
   ▼
Telegram user ko video/PDF milta hai, dashboard me status update
```

1. **Lovable app (yahi project)** — Telegram webhook receive karta hai, links parse karta hai, jobs database me save karta hai, limits check karta hai, aur dashboard dikhata hai.
2. **Worker (alag folder `worker/`, aap Render par deploy karenge)** — Node.js + ffmpeg wala chhota program jo jobs pull karta hai, files banata hai, Telegram par bhejta hai, aur progress report karta hai. Deploy ke liye `Dockerfile` + README (Render ke steps) saath milenge.

## Bot ka behaviour

- `/start` — welcome + aaj ki bachi hui limit.
- Koi bhi URL bhejo → turant "Queued (position N)" reply; ban ne par video/PDF aa jata hai (caption me original filename/URL).
- `.txt` file bhejo → sab links extract (har line se, `Name: url` format bhi support), ek batch banta hai, files ussi order me ek-ek karke aati hain; end me summary (kitni safal / fail).
- Link type auto-detect: `.m3u8` → mp4 convert; `.pdf` → document; `.mp4/.mkv/...` → video; baaki → document.
- Errors user ko simple message me (link dead, size zyada, limit khatam).
- `/status` — chal rahe jobs; `/cancel` — pending jobs cancel.

## Owner control (dashboard + bot)

- Owner login (email/password) — Lovable Cloud auth.
- **Users page**: har Telegram user ki list, aaj ke extract count, per-user daily limit set/override, block/unblock.
- **Settings**: default daily limit (sab users ke liye), max file size, allow-list mode on/off.
- **Jobs page**: sab jobs — status (queued/processing/done/failed), progress, error, retry button, cancel.
- **Worker health**: worker last kab jinda tha, queue length.
- Bot me admin commands bhi: `/limit <user_id> <n>`, `/block <user_id>`.

## Limits & seedhi baatein

- Telegram Bot API se ek file max **50 MB** bhej sakta hai. Isse badi file ke liye worker ko "local Bot API server" mode support karenge (Render par ek extra container) — README me option rahega; pehle version me 50MB se badi file par user ko error milega.
- Daily limit reset raat 12 baje IST.
- Encrypted (AES-128) m3u8 ffmpeg handle kar lega; DRM wale streams nahi banenge.

## Technical details

**Backend (Lovable Cloud)**
- Tables: `bot_users` (telegram_id, name, daily_limit override, blocked), `jobs` (user, url, type, status, progress, file info, error, batch_id, order), `batches`, `settings` (defaults), `usage_daily` (user, date, count), `user_roles` (admin), `worker_heartbeat`. RLS: sirf admin padh/likh sake dashboard se; worker service-secret se API routes ke through.
- Telegram connector link (connect card) → webhook `src/routes/api/public/telegram/webhook.ts`, secret-token verify, `setWebhook` register.
- Worker API (`/api/public/worker/*`, shared `WORKER_SECRET` se protected): `claim` (next job lock karo), `progress`, `complete`, `fail`, `heartbeat`. Replies Telegram par gateway ke through app bhejta hai (queued/limit messages); files worker seedha Bot API se upload karta hai (bot token worker env me — aap BotFather se wahi token Render me daalenge).
- Server functions for dashboard: list jobs/users, set limits, retry/cancel, settings.

**Worker (`worker/`)**
- Node.js 20 + ffmpeg (Docker image `jrottenberg/ffmpeg` base ya apt install), long-poll loop: claim → download (`undici` streaming) / `ffmpeg -i m3u8 -c copy out.mp4` → size check → `sendVideo`/`sendDocument` (multipart) → complete. Concurrency 1–2, retries 2, temp files cleanup.
- Env: `APP_URL`, `WORKER_SECRET`, `TELEGRAM_BOT_TOKEN`. Render "Background Worker" type, Dockerfile diya jayega.

**Frontend**
- Routes: `/` (public status/landing), `/auth`, `/_authenticated/dashboard`, `/jobs`, `/users`, `/settings`. Dark, utility-style dashboard (Space Grotesk + DM Sans), mobile-friendly.

## Build order
1. Lovable Cloud enable, tables + RLS + admin role, Telegram connector link.
2. Webhook: link parsing, .txt extraction, limits, job queue, replies.
3. Worker API routes + `worker/` code + Dockerfile + Render README.
4. Dashboard pages + auth.
5. Webhook register, end-to-end test (aap worker Render par deploy karke bot token daalenge).
