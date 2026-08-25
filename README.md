# Sovereign

Standalone crusade roster / diamond-payout tracker, split out of `capital-records` so it
can run on its own Vercel project with its own database.

## Local dev

```
npm install
DATABASE_URL=postgres://... npm run dev
```

Visit `http://localhost:3000`. On first request the app creates its own tables and
bootstraps a single `admin` account — password is `SITE_PASSWORD` if set, otherwise
`sovereign`. Log in and change it (or add more users) from there once a Users page
exists — see "Not carried over" below.

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
