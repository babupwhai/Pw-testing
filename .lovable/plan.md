# Telegram Uploader Bot (URL → Video/PDF) — Lovable par hi host

## Kya banega

Ek Telegram bot: koi bhi link ya links wali `.txt` file bhejo, aur bot use video ya PDF/document banakar Telegram par bhej dega — line by line, ussi order me. Saath me ek owner dashboard (jobs, users, daily limits).

Abhi sab kuch Lovable par hi chalega — koi Render/Heroku nahi. Baad me chahoge to alag worker jodna aasan rahega (plan ka last section).

## Speed: "link do, seconds me lecture mil jaye"

Sabse tez raasta: file ko hum download-upload karte hi nahi. Telegram khud URL se file uthata hai.

- **Direct links (mp4, mkv, pdf, zip, koi bhi file)** → bot sirf URL Telegram ko de deta hai (`sendVideo`/`sendDocument` with URL). Result: 1–3 second me file chat me. Ye 95% cases cover karta hai aur bilkul instant hai.
- **Agar Telegram URL reject kare** (login/referer chahiye, ya redirect) → bot khud stream karke bhejta hai, tab bhi background me chalta hai aur user ko progress dikhta hai.
- **m3u8 / HLS** → segments ek-ek karke stream hote hain aur seedha ek playable MP4 me jodkar bheje jaate hain (JS remux, ffmpeg ki zarurat nahi). Chhote/medium lecture (~50 MB tak) theek chalenge; poora 2-ghante ka HD lecture is mode me nahi banega — uske liye baad me worker.
- **Batch (.txt)** → 3–4 links ek saath parallel process, order me deliver.

Seedhi baat: Telegram Bot API ek file max **50 MB** hi bhejne deta hai — isse badi file par bot user ko clean message dega ("file too large, direct link bhej raha hoon") aur download link bhej dega.

## Bot ka behaviour

- `/start` — welcome + aaj ki bachi limit.
- URL bhejo → 1 second me "Processing…" message, phir wahi message file me badal jata hai (video/document, caption me naam).
- `.txt` bhejo → har line se link nikalta hai (`Name : url` format bhi), batch banta hai, files order me aati hain, end me summary (safal/fail).
- Type auto-detect: `.m3u8` → video, `.pdf` → document, video extensions → video, baaki → document. Content-type se bhi check.
- `/status` — chal rahe jobs, `/cancel` — pending cancel.
- Fail hone par saaf reason (dead link, too large, limit khatam).

## Owner control

- Owner login (email/password).
- **Users**: har Telegram user, aaj ke uploads, per-user daily limit, block/unblock.
- **Settings**: default daily limit, max size, parallel jobs count.
- **Jobs**: status (queued/processing/done/failed), time liya, error, retry/cancel.
- Bot admin commands: `/limit <user_id> <n>`, `/block <user_id>`, `/stats`.

## Technical details

**Backend (Lovable Cloud)**
- Tables: `bot_users`, `jobs` (url, kind, status, attempts, error, batch_id, position, ms_taken), `batches`, `settings`, `usage_daily`, `user_roles`. GRANTs + RLS: dashboard reads only for admin role; bot/webhook writes via service role in server code.
- Telegram connector link karenge (connect card), phir public webhook route `src/routes/api/public/telegram/webhook.ts` with `X-Telegram-Bot-Api-Secret-Token` verify, aur `setWebhook` register.
- Webhook handler: dedupe by `update_id`, limit check, job insert, instant ack reply — bhaari kaam response ke baad background me (`waitUntil`-style continuation) chalta hai, isliye Telegram timeout nahi hota.
- Delivery path 1 (default, fastest): gateway ke through `sendVideo`/`sendDocument` with `video=<url>` — koi bytes hamare server se nahi guzarte.
- Delivery path 2 (fallback): `fetch` stream → multipart upload to Bot API, size guard 50 MB, no temp files (streaming), abort on limit.
- m3u8: playlist parse (variant → highest bitrate), segments sequential fetch, TS→MP4 remux pure JS (`mux.js`), streamed upload. Encrypted AES-128 support; DRM nahi.
- Retry: 2 attempts with backoff; failure reason job me store.
- Server functions for dashboard: list/filter jobs, users, set limits, retry, cancel, settings.

**Frontend**
- Routes: `/` (landing + bot link + live stats), `/auth`, `/_authenticated/dashboard`, `/jobs`, `/users`, `/settings`.
- Dark utility dashboard, Space Grotesk + DM Sans, mobile-first (aap phone par dekh rahe ho).

## Build order
1. Lovable Cloud enable → tables, GRANTs, RLS, admin role.
2. Telegram connector link + webhook route + `setWebhook`.
3. Fast delivery (URL passthrough) + fallback streaming + limits + batch `.txt`.
4. m3u8 handling.
5. Dashboard + auth pages.
6. End-to-end test: mp4 link, pdf link, m3u8 link, ek `.txt` batch.

## Baad ke liye (optional)
Bade lectures/2-ghante wali HLS files ke liye Render/Heroku par ek chhota ffmpeg worker — jobs table wahi rahega, worker sirf `claim/complete` API use karega. Aaj nahi banayenge, par schema usi hisaab se rakha jayega.
