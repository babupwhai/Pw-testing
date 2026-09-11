# `pw-testing` ko Heroku par host kaise kare

Repo me Heroku ke liye ye files configured hain:

- `package.json`: Node.js 22 aur pnpm runtime pin
- `pnpm-lock.yaml`: repeatable pnpm install
- `Procfile`: production web process
- `app.json`: Heroku app/config metadata
- `.env.example`: required variable names, bina secret values ke

## 1. GitHub se connect
1. Lovable me chat input ke `+` menu → GitHub → Connect project → repo bana lo.
2. Heroku Dashboard me existing **pw-testing** app kholo.
3. App → Deploy tab → Deployment method → **GitHub** → `babupwhai/Pw-testing` repo select → Connect.
4. Enable Automatic Deploys (main branch) — ab har Lovable change auto deploy hoga.

## 2. Config Vars (Settings → Reveal Config Vars)
Ye add karo. Secret values ko GitHub ya `.env` file me commit mat karo:

```
NITRO_PRESET=node-server
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
VITE_SUPABASE_PROJECT_ID=...
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SECRET_KEY=...              # new sb_secret format (recommended)
SUPABASE_SERVICE_ROLE_KEY=...        # legacy server-side key; optional alternative
TELEGRAM_BOT_TOKEN=...               # ya dashboard Settings se daal do
TELEGRAM_API_ID=...                  # my.telegram.org → API development tools
TELEGRAM_API_HASH=...                # my.telegram.org → API development tools
TELEGRAM_WEBHOOK_URL=https://your-app.example/api/public/telegram/webhook
```

`NITRO_PRESET=node-server` zaroori hai — isi se build Heroku ke Node server ke liye banta hai.
Node version `package.json` ke `engines` section se automatically select hota hai.

Heroku Config Vars me values paste karte waqt surrounding quotes mat daalo. Sahi:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
```

Galat:

```text
VITE_SUPABASE_URL="https://your-project.supabase.co"
```

`VITE_*` values build ke waqt browser bundle me inject hoti hain, isliye inhe change karne ke baad app ko dobara deploy karna zaroori hai.

## Single-file lecture uploads

50 MB se bade HLS lectures ko ek MP4 me bhejne ke liye app FFmpeg aur Telegram Bot API local mode use karta hai:

- Heroku app me FFmpeg buildpack Node.js buildpack se **pehle** laga hona chahiye.
- `TELEGRAM_API_ID` aur `TELEGRAM_API_HASH` Config Vars required hain.
- Bot token dashboard Settings ya `TELEGRAM_BOT_TOKEN` me configured hona chahiye.
- `TELEGRAM_WEBHOOK_URL` deployed app ka public `/api/public/telegram/webhook` URL hona chahiye.
- Heroku build exact-version local Bot API binary download karke pinned SHA-256 verify karta hai.
- MP4 pehle dyno ke temporary disk par banta hai, phir Telegram par upload hota hai aur delete ho jata hai.
- Telegram ki 2 GB local Bot API limit cross hone ya temporary failure par app 50 MB parts fallback use karta hai.

## 3. Deploy
Deploy tab → **Deploy Branch**. Build ke baad `Procfile` app ko start karega:

```
web: node .output/server/index.mjs
```

Deploy complete hone ke baad **Resources** tab me confirm karo ki `web` dyno quantity `1` hai.


## 4. Production smoke check

Har deploy se pehle, Config Vars ke production values ke saath local production build par browser smoke check chalao:

```sh
pnpm run smoke:production
```

Ye command pehle production bundle banata hai, phir `/auth` ko real browser me kholta hai. Check tabhi pass hota hai jab React hydration ke baad **Owner login** form visible rahe, Login button enabled ho, aur browser console me koi error na aaye.

Pehli baar machine ya CI runner par Chromium install karna pade to:

```sh
pnpm exec playwright install chromium
```

Smoke check ko `main` par push ya Heroku me **Deploy Branch** click karne se pehle chalao. `VITE_*` Config Vars badalne ke baad bhi is check ko dobara chalao, kyunki ye values build ke waqt browser bundle me inject hoti hain.

## 5. Basic live test

1. `https://pw-testing-f2635b89a1ca.herokuapp.com/` kholo.
2. Heroku → **More → View logs** me startup errors check karo.
3. Login/auth page aur dashboard load karke dekho.
4. Agar bot configured hai to Telegram par `/start` bhejo.

## 6. Bot ko Heroku URL par point karo
1. `https://<app-name>.herokuapp.com/auth` par login karo (pwmarcofounder@gmail.com).
2. Settings page → bot token daalo → Connect. Webhook usi Heroku URL par set ho jayega.
3. `/start` bhejo Telegram par — bot reply karega.

## 7. Queue tick (optional, badi files ke liye)
Heroku Scheduler add-on lagao aur har 10 min ye chalao:

```
curl -X POST https://<app-name>.herokuapp.com/api/public/telegram/tick \
  -H "x-telegram-queue-secret: $TICK_SECRET"
```

`TICK_SECRET` dashboard Settings page par dikhta hai.

## 8. Har future change ka deploy

Automatic Deploys enabled hone par `main` branch par har successful GitHub push Heroku deploy trigger karega. Manual deploy ke liye Deploy tab me latest `main` branch ke saamne **Deploy Branch** click karo.

## 5. Basic live test

1. `https://pw-testing-f2635b89a1ca.herokuapp.com/` kholo.
2. Heroku → **More → View logs** me startup errors check karo.
3. Login/auth page aur dashboard load karke dekho.
4. Agar bot configured hai to Telegram par `/start` bhejo.


## 6. Bot ko Heroku URL par point karo
1. `https://<app-name>.herokuapp.com/auth` par login karo (pwmarcofounder@gmail.com).
2. Settings page → bot token daalo → Connect. Webhook usi Heroku URL par set ho jayega.
3. `/start` bhejo Telegram par — bot reply karega.


## 7. Queue tick (optional, badi files ke liye)
Heroku Scheduler add-on lagao aur har 10 min ye chalao:

```
curl -X POST https://<app-name>.herokuapp.com/api/public/telegram/tick \
  -H "x-telegram-queue-secret: $TICK_SECRET"
```

`TICK_SECRET` dashboard Settings page par dikhta hai.


## 8. Har future change ka deploy

Automatic Deploys enabled hone par `main` branch par har successful GitHub push Heroku deploy trigger karega. Manual deploy ke liye Deploy tab me latest `main` branch ke saamne **Deploy Branch** click karo.
