# Sovereign

Standalone crusade roster / diamond-payout tracker, split out of `capital-records` so it
can run on its own Vercel project with its own database.

## Run it on a Windows PC (live database)

1. Install **Node.js 22+** (https://nodejs.org) and **Git**, then clone this
   repo.
2. Double-click **`Install Sovereign.exe`** (or `install.bat`, which it runs).
   It installs packages for the website and the bot, then asks for:
   - **the passphrase** for the shared settings, if `.env.enc` is in the
     repo. Ask the admin; it's shared privately, never in this repo. It
     unlocks the live database URL kept in git encrypted (AES-256). Without
     it, you paste the `DATABASE_URL` instead.
   - `DISCORD_TOKEN` and `GROWTH_BOT_SECRET`: **only on the one PC that runs
     the bot.** Press Enter everywhere else.

   They're saved in `.env` and `discord-bot.env`, which git ignores. Keep
   them private. It tests both connections, then starts the website and the
   bot **in the background, with no windows**, and opens
   http://localhost:3001. From then on they start by themselves whenever you
   sign in to Windows, and restart by themselves if they crash.

Afterwards:

| | |
|---|---|
| **Sovereign** shortcut (desktop) | Opens the website, starting it first if needed |
| `logswebsite.log`, `logsot.log` | What they're doing (there are no windows to watch) |
| `stop-all.bat` | Stops both until the next sign-in, or until the shortcut / `start-all.bat` is used |
| `uninstall.bat` | Stops both and removes the startup and desktop shortcuts |

Port **3001**, because Capital Records uses 3000 on the same PC.
`stop-all.bat` only stops this folder's copies, never Capital's.

**The local site uses the live database:** anything you change locally
changes the real data. Run the bot on **one PC only**, or every Discord post
gets answered twice.

To change the settings later, run `node scripts/setup-env.js --reset`.

**Sharing the settings with another PC:** run
`node scripts/env-secret.js encrypt` (it asks for a new passphrase; add
`--with-bot` to include the bot's settings too) and commit `.env.enc`. Share
the passphrase privately. **Never commit `.env` itself.**

Rebuild the installer and its icon: `node scripts/make-icon.js`, then
`installeruild.bat`.

## Deploying as its own Vercel project

1. Create a new empty GitHub repo and push this folder to it:
   ```
   git remote add origin <your-new-repo-url>
   git push -u origin master
   ```
2. Create a new Postgres database (e.g. a new Neon project) — this app has its own
   schema and does not share data with capital-records.
3. In Vercel, "Add New Project" → import that new GitHub repo.
4. Set these Environment Variables on the Vercel project:
   - `DATABASE_URL` — your new Postgres connection string
   - `SITE_PASSWORD` — password for the bootstrap `admin` account (optional, defaults to `sovereign`)
   - `SESSION_SECRET` — any random string (optional but recommended — without it, sessions reset on every cold start)
5. Deploy. `/` serves the crusade page directly; `/login` signs in.

## What's included

Everything under the original app's "Sovereign / Crusade" section: crusade guilds,
crusades/teams/items/fees, the party roster, guild salary + area-capture bonus shares,
the master member list, and the standalone raffle — plus enough auth (login/logout/
session, roles) to gate editing.

## Not carried over (yet)

The original app's Users-management and Activity-Log *pages* live in its shared SPA
shell and weren't ported — this app has the underlying `/api/users` and
`/api/activity-log` endpoints (admin-only) but no UI for them yet. For now, manage
users by calling those endpoints directly (e.g. via `curl` while logged in as admin),
or ask for the pages to be added.

## Existing data

This is a fresh schema — none of capital-records' existing crusades/members/raffle
history is copied over. That's a separate one-time export/import step if you want to
carry history forward instead of starting clean.
