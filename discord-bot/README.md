# Sovereign Growth Rate bot

Watches one Discord channel for messages containing `IGN:`, `Class:`, and a
screenshot attachment, and saves each as a submission in the Sovereign app
(visible on its **Growth Rate** page).

## 1. Create the Discord bot application

1. Go to https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it (this is `DISCORD_TOKEN`).
3. Still on the **Bot** tab, under **Privileged Gateway Intents**, turn on
   **Message Content Intent**. Without this the bot receives every message
   with an empty `content` and can never see the IGN/Class text.
4. **OAuth2 → URL Generator**: check scope `bot`, then permissions
   **View Channel**, **Send Messages**, **Read Message History**,
   **Add Reactions**. Open the generated URL and invite it to your server.

## 2. Configure

```
cd discord-bot
cp .env.example .env
```

Fill in `.env`:
- `DISCORD_TOKEN` — from step 1.
- `DISCORD_CHANNEL_ID` — already defaults to the growth-rate channel
  (`1547642467728236706`); only change it if you move channels.
- `SOVEREIGN_API_BASE` — your deployed Sovereign app's URL, e.g.
  `https://sovereign-nightcrows.vercel.app`.
- `GROWTH_BOT_SECRET` — make up a long random string, then set the **same**
  value as an environment variable named `GROWTH_BOT_SECRET` on the Sovereign
  app itself (Vercel project → Settings → Environment Variables). This is
  the shared secret the bot uses to authenticate its API calls — anyone who
  has it could post fake submissions, so treat it like a password.

## 3. Run it

```
npm install
npm start
```

You should see `Logged in as <BotName> — watching channel ...` in the
console. Post a message like this in the channel:

```
IGN: RTXCJKIL
Class: Ultimate Martialist
```
...with the Artifacts-tab screenshot attached, and the bot should react ✅
and it'll show up on the Sovereign app's Growth Rate page. If something's
missing it reacts ❌ and replies explaining what.

## 4. Keep it running (hosting)

This bot needs a persistent process (it holds a live connection to Discord),
so it can't run on Vercel's serverless functions the way the main app does.
Cheapest options for a small guild bot:

- **Railway** (https://railway.app) — connect this GitHub repo, set the
  service's root directory to `discord-bot/`, add the four env vars above,
  deploy. Free tier covers a bot this size comfortably.
- **Render** (https://render.com) — create a **Background Worker** (not a
  Web Service, since this isn't an HTTP server), same root directory and
  env vars.
- Any small always-on VPS (e.g. a $4-6/mo box) works too — just
  `git clone`, `npm install`, and run it under `pm2` or a systemd service so
  it restarts if it crashes or the machine reboots.

Editing or deleting the original Discord message updates or removes its
entry on the Growth Rate page automatically.
