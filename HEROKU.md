# Heroku par host kaise kare (GitHub se)

## 1. GitHub se connect
1. Lovable me chat input ke `+` menu → GitHub → Connect project → repo bana lo.
2. Heroku Dashboard → New → Create new app → app name choose karo.
3. App → Deploy tab → Deployment method → **GitHub** → repo select → Connect.
4. Enable Automatic Deploys (main branch) — ab har Lovable change auto deploy hoga.

## 2. Config Vars (Settings → Reveal Config Vars)
Ye add karo (values project ki `.env` file se copy karo):

```
NITRO_PRESET=node-server
NODE_VERSION=22
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
VITE_SUPABASE_PROJECT_ID=...
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...        # optional, server-side kaam ke liye
TELEGRAM_BOT_TOKEN=...               # ya dashboard Settings se daal do
```

`NITRO_PRESET=node-server` zaroori hai — isi se build Heroku ke Node server ke liye banta hai.

## 3. Deploy
Deploy tab → Deploy Branch. Build ke baad `Procfile` app ko start karega:

```
web: node .output/server/index.mjs
```

## 4. Bot ko Heroku URL par point karo
1. `https://<app-name>.herokuapp.com/auth` par login karo (pwmarcofounder@gmail.com).
2. Settings page → bot token daalo → Connect. Webhook usi Heroku URL par set ho jayega.
3. `/start` bhejo Telegram par — bot reply karega.

## 5. Queue tick (optional, badi files ke liye)
Heroku Scheduler add-on lagao aur har 10 min ye chalao:

```
curl -X POST https://<app-name>.herokuapp.com/api/public/telegram/tick \
  -H "x-telegram-queue-secret: $TICK_SECRET"
```

`TICK_SECRET` dashboard Settings page par dikhta hai.
