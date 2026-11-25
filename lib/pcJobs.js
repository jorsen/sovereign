// Hands screenshot reading from the website (Vercel, CPU time billed) to
// the PC bot (discord-bot/), which runs the same code for free.
//
// The website answers Discord as before, saves the job here, and waits a
// few seconds. The bot learns about it from Discord itself -- the
// Rescan post turning "Rescanning…" arrives at the bot as gateway events -- and claims the job
// by its id. If nobody claims it in time (PC off, bot down), the website
// claims it and reads it itself, exactly as before. A claim is a single
// UPDATE … WHERE status = 'queued', so only one side ever runs a job.
//
// No polling from the PC: the database is only touched when there's a job.
const { sql } = require('./db');

const WAIT_FOR_PC_MS = 8000;
const CHECK_EVERY_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = sql`
      CREATE TABLE IF NOT EXISTS pc_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`.catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

// Job ids, from what both sides can see: the post being rescanned.
const rescanJobId = (messageId) => `rescan:${messageId}`;

const handOffEnabled = () => Boolean(process.env.VERCEL) && process.env.PC_OCR !== 'off';

/**
 * Website side: offer the job to the PC; run it here (runHere) if the PC
 * doesn't take it within a few seconds. Resolves to 'pc' or 'here'.
 */
async function offerToPc(id, kind, payload, runHere) {
  if (!handOffEnabled()) return runHere().then(() => 'here');
  try {
    await ensureTable();
    // Jobs never claimed (both sides down mid-way) are cleared after a day;
    // an interaction token is useless after 15 minutes anyway.
    await sql`DELETE FROM pc_jobs WHERE created_at < NOW() - INTERVAL '1 day'`;
    await sql`INSERT INTO pc_jobs (id, kind, payload) VALUES (${id}, ${kind}, ${JSON.stringify(payload)}::jsonb) ON CONFLICT (id) DO NOTHING`;
  } catch (err) {
    console.error('Could not offer the job to the PC, reading here:', err.message);
    return runHere().then(() => 'here');
  }
  for (const until = Date.now() + WAIT_FOR_PC_MS; Date.now() < until;) {
    await sleep(CHECK_EVERY_MS);
    const { rows } = await sql`SELECT status FROM pc_jobs WHERE id = ${id}`.catch(() => ({ rows: [{ status: 'queued' }] }));
    if (rows[0]?.status !== 'queued') return 'pc';
  }
  const { rows } = await sql`UPDATE pc_jobs SET status = 'website' WHERE id = ${id} AND status = 'queued' RETURNING id`;
  if (!rows.length) return 'pc'; // the PC took it at the last moment
  try {
    await runHere();
  } finally {
    await sql`DELETE FROM pc_jobs WHERE id = ${id}`.catch(() => {});
  }
  return 'here';
}

/**
 * PC side: claim the job with this id, if there is one. The bot may hear of
 * it before the website has saved it, so a few tries over ~4 s.
 * @returns {Promise<null | { id, kind, payload }>}
 */
async function claimForPc(id, { tries = [0, 500, 1000, 1500, 2500] } = {}) {
  await ensureTable();
  for (const wait of tries) {
    if (wait) await sleep(wait);
    // Saved just now (between the two queries): claim it on the next go.
    for (let again = 0; again < 2; again++) {
      const { rows } = await sql`UPDATE pc_jobs SET status = 'pc' WHERE id = ${id} AND status = 'queued' RETURNING id, kind, payload`;
      if (rows.length) return rows[0];
      // Already taken by the website: no point waiting.
      const { rows: seen } = await sql`SELECT status FROM pc_jobs WHERE id = ${id}`;
      if (!seen.length) break;
      if (seen[0].status !== 'queued') return null;
    }
  }
  return null;
}

const finishJob = (id) => sql`DELETE FROM pc_jobs WHERE id = ${id}`.catch(() => {});

module.exports = { offerToPc, claimForPc, finishJob, rescanJobId };
