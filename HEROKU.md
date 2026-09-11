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
SUPABASE_SERVICE_ROLE_KEY=...        # optional, server-side kaam ke liye
TELEGRAM_BOT_TOKEN=...               # ya dashboard Settings se daal do
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

## 3. Deploy
Deploy tab → **Deploy Branch**. Build ke baad `Procfile` app ko start karega:

```
web: node .output/server/index.mjs
```

Deploy complete hone ke baad **Resources** tab me confirm karo ki `web` dyno quantity `1` hai.

## 4. Basic test

1. `https://pw-testing-f2635b89a1ca.herokuapp.com/` kholo.
2. Heroku → **More → View logs** me startup errors check karo.
3. Login/auth page aur dashboard load karke dekho.
4. Agar bot configured hai to Telegram par `/start` bhejo.

## 5. Bot ko Heroku URL par point karo
1. `https://<app-name>.herokuapp.com/auth` par login karo (pwmarcofounder@gmail.com).
2. Settings page → bot token daalo → Connect. Webhook usi Heroku URL par set ho jayega.
3. `/start` bhejo Telegram par — bot reply karega.

## 6. Queue tick (optional, badi files ke liye)
Heroku Scheduler add-on lagao aur har 10 min ye chalao:

```
curl -X POST https://<app-name>.herokuapp.com/api/public/telegram/tick \
  -H "x-telegram-queue-secret: $TICK_SECRET"
```

`TICK_SECRET` dashboard Settings page par dikhta hai.

## 7. Har future change ka deploy

Automatic Deploys enabled hone par `main` branch par har successful GitHub push Heroku deploy trigger karega. Manual deploy ke liye Deploy tab me latest `main` branch ke saamne **Deploy Branch** click karo.
