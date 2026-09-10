# Sovereign Growth Rate bot

Handles the `/uniongr` slash command (`ign`, `class`, `guild`, `lamp`,
`screenshot`), posts a confirmation embed into the growth-rate channel, and
saves the submission in the Sovereign app (visible on its **Growth Rate**
page). There's no free-text posting path anymore -- `/uniongr` is the only
way to submit.

## 1. Create the Discord bot application

1. Go to https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it (this is `DISCORD_TOKEN`).
3. **OAuth2 → URL Generator**: check scopes `bot` and
   `applications.commands`, then permissions **View Channel**,
   **Send Messages**, **Read Message History**. Open the generated URL and
   invite it to your server.
4. In the growth-rate channel's own Permissions, make sure **Use
   Application Commands** is allowed for whichever role your members have
   -- if it's denied there, members can see the channel but `/uniongr`
   won't show up for them at all.

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

## 3. Register the /uniongr slash command

```
npm install
node register-commands.js
```

This needs `DISCORD_CLIENT_ID` (Developer Portal → General Information →
Application ID) in `.env`. Also set `DISCORD_GUILD_ID` (your server's ID)
if you want the command to show up instantly instead of waiting up to an
hour for a global command to propagate.

## 4. Run it

```
npm start
```

You should see `Logged in as <BotName> — watching channel ...` in the
console. Members submit with:

```
/uniongr ign:<name> class:<pick from dropdown> guild:<pick from dropdown> lamp:<1-25> screenshot:<attach the Artifacts-tab image>
```

The bot posts a confirmation embed into the channel and replies privately
(✅ or an error) to whoever ran the command. It shows up on the Sovereign
app's Growth Rate page right away. Deleting that confirmation embed later
removes the entry from the page too.

## 5. Keep it running (hosting)

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

Deleting the bot's confirmation embed removes that entry from the Growth
Rate page automatically. To fix a typo on an existing submission, use the
Growth Rate page's own Edit button (admin-only) instead of touching Discord.
