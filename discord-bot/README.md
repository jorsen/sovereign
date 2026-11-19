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
/uniongr same-ign ign:<name> class:<pick from dropdown> guild:<pick from dropdown> lamp:<1-25> growthrate:<the Growth Rate number> screenshot:<attach the Artifacts-tab image>
/uniongr switched-ign oldign:<pick your old IGN> ign:<new name> class:... (same fields as above)
```

The bot posts a confirmation embed into the channel and replies privately
(✅ or an error) to whoever ran the command. It shows up on the Sovereign
app's Growth Rate page right away. Deleting that confirmation embed later
removes the entry from the page too.

Someone who changed their IGN uses `/uniongr switched-ign`, which also asks for
the old IGN (it suggests every name on our lists as they type). That post is
not saved straight away: it waits under **IGN change requests** on the Growth
Rate page until an admin approves it, and approving renames the old IGN
everywhere.

### Pinned how-to guide

`node post-guide.js` posts the "How to Submit Your Growth Rate" guide in the
channel and pins it. To change the wording later, edit `post-guide.js` and
run `node post-guide.js <messageId>` to update that same message in place
(current one: `1564743508433043527`).

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

## /attendance (boss attendance)

`/attendance boss:<pick> screenshot:<image> [screenshot2..4]`
reads every **blue** (party), **green** (guild) and **light green**
(alliance) nameplate off the screenshots, saves the attendees on the site's
World Boss (or Balthazard) page, and posts the result in the attendance
channel (`1573000319837806622`, override with `ATTENDANCE_CHANNEL_ID`).

- **boss** is a dropdown of the site's boss list (`lib/bosses.js`), so only
  a real boss can be picked. After adding a boss there, run
  `node register-commands.js` again so the dropdown picks it up.
- **Date and time are automatic**: when the screenshots were uploaded (the
  earliest one, read from the attachments' Discord IDs), on Philippines
  time (UTC+8), the clock the site's records use. When a loot list is
  attached, its exact kill time ("11.20.2026 00:55") is used instead.
- **Saved** (`lib/attendanceRecords.js`): every name matched to the Growth
  Rate list, ⚠️ guesses included; ❓ names (not on the list) are not saved.
  New records start as result "pending" -- set Win/Lose on the site. A
  second /attendance for the same boss within 30 minutes is treated as
  another screenshot of the same kill and adds its names to that record.
  Each save shows on the site's Activity Log as "<name> (Discord)".
- **Loot**: a screenshot of the in-game loot distribution list can be
  attached too (any screenshot slot, with or without battle screenshots).
  `lib/lootOcr.js` recognizes it by its "11.20.2026 00:55" rows and reads
  each row's item, boss, guild, kill time and the quantity badge on the
  icon; `lib/lootMatch.js` completes cut-off names ("al of Advancement" →
  Higher Seal of Advancement) from the item names already on the site,
  using which items that boss has dropped before to break ties. Totals go
  on that kill's record (found by boss + kill time, within 30 minutes; a
  new pending record if there's none yet). If no time was typed, the
  attendance uses the loot list's kill time, so both land on one record.
  A record that already has loot is left alone, so posting the same loot
  screenshot twice never counts it twice. Items not in the site's list are
  shown with ❓ and not saved. Overlapping screenshots of one scrolled list
  (attached in the same /attendance) are merged without double-counting.

The post itself shows the boss, the date/time (Discord shows it in each
member's own language and timezone), the attendee count and whether it was
saved, with no screenshot (so the thread doesn't repeat the image at its
top); the bot then starts a thread on that post and lists the attendees there
(numbered, with the ⚠️ / ❓ marks below). The bot needs Create Public
Threads and Send Messages in Threads in the channel. If the thread can't be
created, the list is put in the post itself instead.

Reading is free and local: `lib/attendanceOcr.js` keeps only pixels in
those three exact name colors, cuts out each nameplate, and reads it with
Tesseract OCR (`tesseract.js`). The English/Korean/Traditional Chinese
language data lives in `ocr-data/` so nothing is downloaded at runtime.
In-game chat uses the same green as guild names, so lines that start at the
left screen edge are skipped.

Each reading is then matched against the IGNs on the Growth Rate page
(`lib/rosterMatch.js`), so small misreads are posted with the exact spelling
the site has (IicyFraith -> JuicyFruit). Guesses that aren't a clear match
are marked ⚠️ with what OCR actually read, and names not on the Growth Rate
list at all are marked ❓.

Each nameplate is read several ways (plain and thickened strokes, line and
word mode, Korean and Chinese readers), and the matching uses whichever
reading fits a Growth Rate name. Extra readings only count for close
matches, so they can't pull in a member who wasn't there. Text size is
measured from the screenshot itself, so cropped, phone and 4K screenshots
all work; JPEGs get a wider color tolerance.

OCR is not perfect: names partly covered by spell effects or another
nameplate, and some Korean/Chinese characters, can come out wrong. Those
are marked ⚠️ in the post so someone can check the spelling.

Like `/uniongr`, the command is handled by the Vercel app
(`lib/discordInteractions.js`). After deploying, run
`node register-commands.js` here once so Discord learns the new command.

To test the reader on local screenshots without Discord:

```
npm run read-names -- path/to/screenshot.png
```

Set `ATTENDANCE_OCR_DEBUG=1` to also print every text line it found and how
each OCR reader read it.
