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

`/attendance boss:<pick> screenshot:<image> [screenshot2..10]` or
`/attendance boss:<pick> link:<Discord message link(s)>`
reads every **blue** (party), **green** (guild) and **light green**
(alliance) nameplate off the screenshots, saves the attendees on the site's
World Boss (or Balthazard) page, and posts the result in the attendance
channel (`1573000319837806622`, override with `ATTENDANCE_CHANNEL_ID`).

- **boss** is a dropdown of the site's boss list (`lib/bosses.js`), so only
  a real boss can be picked. After adding a boss there, run
  `node register-commands.js` again so the dropdown picks it up.
- **Time of Death comes from the loot list** ("11.20.2026 00:55", already
  Philippines time, the clock the site's records use), so a loot list
  screenshot is required: without one, or with a loot list for a different
  boss than the one picked, the bot refuses and saves nothing.
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
  Loot rows of one boss within 30 minutes are one kill (Ducas at 11:00 and
  Dergio at 11:01). Items the record doesn't have yet are added; items it
  already has (by name) are skipped, so posting the same loot list twice
  never counts it twice. Item names are compared ignoring spaces, and cut-off
  names the trainer confirmed before (`attendance_ocr_loot`, judged like the
  name trainer: still on the record = right) are reused. Items not in the
  site's list are shown with ❓ and not saved (to teach the bot a new item
  before it's on any record, add its full name to `lib/extraItems.js`); a long row garbled all
  through ("EaeencelniEurses") still counts as the item it is far closest to
  (55%+ alike and 15+ points ahead of any other item). Scraps under 5 letters are
  dropped. Overlapping screenshots of one scrolled list (attached in the same
  /attendance) are merged without double-counting.
- **Loot icons**: a cut-off name can fit several items ("Enhancement Scroll":
  Brilliant Armor, Pitch Black Accessory, ...). Each row's icon is kept as a
  tiny 6x6 color picture (`attendance_ocr_icons`), learned from rows whose
  name was read in full, and from admins' fixes: when the bot had to guess
  (by what that boss dropped before) and an admin changed the item on the
  site, the icon is learned as the corrected item. A guess nobody changed
  teaches nothing. Once an item's icon is known, the icon decides.
- **Speed**: names are read first; a screenshot with 2+ nameplates skips the
  loot-list check (a whole-screen OCR). A nameplate read clearly at once
  isn't read again with more settings, sizes or zooms -- those are only for
  unclear ones. All screenshots are shown on the post and the footer says how
  many were read.

**Review before saving**: nothing is saved straight away. While reading, the
post shows "⏳ Reading screenshot 2 of 5…"; then it becomes a yellow
**Review** with the attendees, loot and screenshots, a picker to untick
anyone who wasn't there (up to 50 names), **Add a missed member** (a form;
the name must be on the Growth Rate list), **Save** and **Cancel**. Only
whoever ran the command can use them. **Save** writes the ticked names and
the loot to the site and turns the post into the record ("Saved ✅ 8 names
logged to …", with 🔄 Rescan); **Cancel** saves nothing. A 🔄 Rescan also
opens a review (starting from the names already on the post, incl. ones
added by hand) and replaces the record on Save; its Cancel puts the post
back. Unticked names teach the trainer that reading was wrong. Unfinished
reviews (`attendance_pending`) are dropped after 3 days. **boss** is
optional: without it the boss comes from the loot list.

**No re-uploading**: instead of attaching, paste the link of the Discord
message(s) that already have the screenshots in `link:` (right-click the
message > Copy Message Link; several links separated by spaces). The bot
opens each message and reads its images (attachments and image links);
direct image links (cdn.discordapp.com/attachments/...) work too. Links and
attachments can be mixed, 10 images in all. The bot must be able to see
that channel.

**Duplicates**: the same screenshot twice (uploaded/linked again, or re-saved
as another format or size) is read, posted and counted once; the footer
says how many were skipped, and a Rescan removes extra copies from an
older post. A loot list scrolled in two overlapping screenshots (either
direction) is merged without counting the shared rows twice.

**Big fights**: attach up to 10 screenshots of the same kill from different
angles; every one is read and all names merge into one list.

**Trainer** (gets better with use): every name saved from a misread
nameplate is remembered in `attendance_ocr_matches` -- what was read
("RADiRIP") and who it was saved as (BÁDtRiP). Whether it was right is
judged from the record as it is now: still in the attendees = confirmed,
removed by an admin or a rescan = wrong. A misreading counts as confirmed
only once it held up on 2+ different kills (one kill isn't proof: an
unfixed wrong guess is "on the record" too, and rescanning that kill must
not confirm the mistake with itself). Confirmed misreadings (4+
characters) are then matched instantly and very close ones more easily;
wrong ones are never matched to that member again. So fixing records on
the site is what trains it. It also weighs attendance history (last 30
days of World Boss / Balthazard kills): regulars need a slightly less
clear reading to be guessed, members with no recent attendance a clearer
one. Exact reads are never affected. A reading is only blocked for a
member after it was wrong on 2+ different kills too (a rescan of blurry
copies once dropped a real attendee and would otherwise block her name).
Decorated names (คnNikaツ, 자본丶Suszane) are also matched on their Latin
part ("Nika"), and a dash-framed number inside junk ("ee一41一") still
finds the number name.

**Correcting a wrong scan**: press the **🔄 Rescan** button under the post.
It reads the post's own screenshots again -- nothing to re-upload -- with
the deep scan (every nameplate gets every reading setting, size and zoom,
not just the unclear ones), replaces the saved record the same way
`rescan: True` does, and edits the post in place ("rescanned by <name>" in
the footer). The button shows "Rescanning…" and can't be pressed again
while it runs; if the rescan fails, only the presser sees the error and the
post stays as it was. Posts made before the button existed don't have it.

Only names read off the screenshots are listed: whoever runs /attendance is
not added automatically (`ADD_SUBMITTER` in `lib/discordInteractions.js`,
off for now).

Or run `/attendance` again for that kill (same boss + its loot list) with
**rescan: True**. Instead of adding to the record, it
replaces the saved attendees with the new scan (bonus points, if the kill
has any, are recomputed for the new names) and replaces the loot -- unless
some of it already has a price or sale entered on the site, in which case
the loot is kept and the post says to fix it there. Without rescan, a
second /attendance only adds names (a second screenshot of the same fight).
Single wrong names can also just be edited on the site.

The result is one post: **Boss**, **Time of Death** (Discord shows it in
each member's own language and timezone), **Attendees List** (numbered) and
**Loots**, with all the screenshots (up to 10) shown as galleries of 4 +
4 + 2. Names are
listed plainly -- guesses (closest Growth Rate name to a blurry reading)
included, without marks -- and readings that match no member aren't listed.
Only loot items missing from the site's item list get a ❓ (not saved). The
footer notes anything not saved. The bot reacts ✅ when done (⚠️ if saving to the site failed, ❌ if
it stopped with an error).

Reading is free and local: `lib/attendanceOcr.js` keeps only pixels in
those three exact name colors, cuts out each nameplate, and reads it with
Tesseract OCR (`tesseract.js`). The English/Korean/Traditional Chinese/Japanese
language data lives in `ocr-data/` so nothing is downloaded at runtime.
In-game chat uses the same green as guild names, so chat is skipped: lines
that start at the left screen edge, and stacks of 3+ name-colored rows in
the left 12% of the screen that line up on the left (chat lines indented by
a rank icon or channel tag, "🏆 STORM: eto? 22:33"). Fighting nameplates are
scattered, not a column like that. Previously only lines starting at the
left screen edge are skipped. A faded guild green (a soft capture, a short
green name inside a green skill effect) is caught by its hue too.

Japanese names (とらふ) get a fourth, Japanese-only reader (`ocr-data/jpn`);
voicing marks (゛゜, a pixel or two on small text) are ignored when matching
(とらぶ = とらふ). A name drawn in a darker party blue than the rest
(자본丶Sammyyy) is caught by a dim-blue fallback, which only accepts clear
matches and doesn't count toward the measured text size.

Chinese names (殺豬小隊ฅ金元寶ฅ, 鬱金香都沒妳的浴巾香) get a third, Chinese-only
reader on unclear nameplates -- paired with English, the Chinese reader
turns small Han text into Latin junk. Each reading of a small Han name gets
a few characters wrong, but different ones, so a member whose Han
characters are 75%+ covered by 2+ readings (and clearly more than anyone
else) is matched. Han/Hangul characters count double for the short-name
rules. Nameplates at the very top of a cropped screenshot, at the left
screen edge (a lone row, not stacked chat rows), number names whose digits
touch (一41一), and the duller name colors of small screenshots are found too.

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
