const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

// Client creation is deliberately lazy: neon() itself can throw synchronously
// on a malformed connection string, and doing that at module load would crash
// every request (even the login page) on a cold start. Deferring it here means
// any failure only surfaces when a route actually queries the database, where
// callers already wrap ensureSchema()/queries in a try/catch for a clean 500.
let sqlClient = null;
let sqlInitError = null;

function getSqlClient() {
  if (sqlClient) return sqlClient;
  if (sqlInitError) throw sqlInitError;
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    sqlInitError = new Error('DATABASE_URL (or POSTGRES_URL) environment variable is required');
    throw sqlInitError;
  }
  try {
    sqlClient = neon(connectionString, { fullResults: true });
    return sqlClient;
  } catch (err) {
    sqlInitError = err;
    throw err;
  }
}

const sql = (...args) => getSqlClient()(...args);

// scrypt (built into Node, no extra dependency) with a random per-password
// salt stored alongside the hash as "salt:hash", both hex-encoded.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, salt, 64);
  const hashBuf = Buffer.from(hashHex, 'hex');
  return hashBuf.length === hash.length && crypto.timingSafeEqual(hash, hashBuf);
}

let schemaReady = null;

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      // Individual accounts. role is one of 'admin' | 'editor' | 'viewer'.
      // Admin: everything. Editor: same day-to-day editing access as admin,
      // just not user management. Viewer: read-only, same as an anonymous
      // visitor.
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'viewer',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      const { rows: userCountRows } = await sql`SELECT COUNT(*)::int AS count FROM users`;
      if (userCountRows[0].count === 0) {
        // Bootstraps the very first admin account so there's always a way
        // in on a fresh database — log in as "admin" with SITE_PASSWORD (or
        // the "sovereign" fallback below) and take it from there.
        const sitePassword = process.env.SITE_PASSWORD || 'sovereign';
        await sql`
          INSERT INTO users (id, username, password_hash, role)
          VALUES (${crypto.randomUUID()}, 'admin', ${hashPassword(sitePassword)}, 'admin')
          ON CONFLICT (username) DO NOTHING
        `;
      }

      // Append-only audit trail — one row per mutating action taken through
      // the app. username/role are denormalized snapshots so history stays
      // readable even after a user is renamed or removed.
      await sql`
        CREATE TABLE IF NOT EXISTS activity_log (
          id UUID PRIMARY KEY,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          username TEXT NOT NULL,
          role TEXT NOT NULL,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          description TEXT NOT NULL,
          before_data JSONB,
          after_data JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      // A small admin-managed guild list (name + color tag).
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_guilds (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      // A crusade is just the shared date/event container -- name,
      // event_date. Everything that drives a payout lives on crusade_teams
      // instead, one row per team, so two teams on the same crusade can
      // have entirely different rewards/outcomes.
      await sql`
        CREATE TABLE IF NOT EXISTS crusades (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          event_date DATE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_teams (
          id UUID PRIMARY KEY,
          crusade_id UUID NOT NULL REFERENCES crusades(id) ON DELETE CASCADE,
          team_number INT NOT NULL,
          war_type TEXT,
          stance TEXT,
          area TEXT,
          leader TEXT,
          result TEXT NOT NULL DEFAULT 'pending',
          diamond_reward NUMERIC NOT NULL DEFAULT 0,
          attendance_pct NUMERIC NOT NULL DEFAULT 50,
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (crusade_id, team_number)
        )
      `;
      // Named items per crusade TEAM (e.g. Morion x215, Guild Coins x500),
      // each split evenly across that team's own attendees only.
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_items (
          id UUID PRIMARY KEY,
          crusade_id UUID NOT NULL REFERENCES crusades(id) ON DELETE CASCADE,
          team_id UUID REFERENCES crusade_teams(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          quantity NUMERIC NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // A management fee takes a percentage of a team's total diamond
      // reward off the top, before the remainder is split via the normal
      // attendance/bid formula.
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_fees (
          id UUID PRIMARY KEY,
          crusade_id UUID NOT NULL REFERENCES crusades(id) ON DELETE CASCADE,
          team_id UUID REFERENCES crusade_teams(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          guild_name TEXT,
          percent NUMERIC NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // A standing list of fee recipients (not tied to any crusade/team) --
      // copied onto crusade_fees automatically the first time a new team is
      // ever saved. Editing this list only affects teams created afterward.
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_default_fees (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          guild_name TEXT,
          percent NUMERIC NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // party_slot groups a team's members into battle parties of up to 5
      // (see the 5-member cap enforced in the participant routes below).
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_participants (
          id UUID PRIMARY KEY,
          crusade_id UUID NOT NULL REFERENCES crusades(id) ON DELETE CASCADE,
          party_number INT NOT NULL DEFAULT 1,
          party_slot INT NOT NULL DEFAULT 1,
          name TEXT NOT NULL,
          guild_name TEXT,
          position TEXT,
          gold_bid NUMERIC NOT NULL DEFAULT 0,
          attended BOOLEAN NOT NULL DEFAULT true,
          paid BOOLEAN NOT NULL DEFAULT false,
          manual_diamonds NUMERIC NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // manual_diamonds was added after crusade_participants first shipped --
      // this backfills it onto any table created before that column existed.
      await sql`ALTER TABLE crusade_participants ADD COLUMN IF NOT EXISTS manual_diamonds NUMERIC NOT NULL DEFAULT 0`;

      // Master roster of everyone ever saved into a crusade party roster,
      // one row per unique name (case-insensitive) — kept up to date by
      // upsertSovereignMember() every time a crusade_participants row is
      // saved, so it always reflects each person's most recent guild.
      await sql`
        CREATE TABLE IF NOT EXISTS sovereign_members (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          guild_name TEXT,
          position TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      // Standalone raffle, independent of any crusade -- an append-only
      // stack of draw results (member + which item they won). The pool for
      // the *next* draw is whoever from sovereign_members hasn't already won
      // since the stack was last cleared -- derived from this table, not
      // stored separately.
      await sql`
        CREATE TABLE IF NOT EXISTS raffle_winners (
          id UUID PRIMARY KEY,
          member_name TEXT NOT NULL,
          guild_name TEXT,
          item TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

module.exports = { sql, ensureSchema, hashPassword, verifyPassword };
