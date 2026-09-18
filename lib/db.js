const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

// The Postgres driver parses a "timestamp without time zone" value (like
// world_boss_attendance.event_date) into a JS Date using the RUNNING
// PROCESS's local timezone -- meaning the exact same stored value would
// read back differently depending on what machine/environment happened to
// run the request. Pinning this explicitly guarantees the admin's own
// wall-clock input (from a <input type="datetime-local">, deliberately
// stored with no timezone conversion -- see the event_date column comment
// below) round-trips identically everywhere, in dev and in production,
// regardless of the host's own default timezone.
process.env.TZ = 'UTC';

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

// neon()'s tagged-template function also carries a `.transaction()` method
// for running multiple queries atomically over one connection -- but `sql`
// above is a plain wrapper arrow function, so that method isn't reachable
// through it. Expose it separately for callers (e.g. diamond transfers) that
// need two writes to commit-or-rollback together.
const sqlTransaction = (queries) => getSqlClient().transaction(queries);

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

      // Populated by the Discord bot watching the growth-rate submission
      // channel -- one row per Discord message, keyed on discord_message_id
      // so an edited message updates its row instead of duplicating. The
      // screenshot itself is stored as bytes here (not just a Discord CDN
      // URL) since Discord's attachment URLs are signed and expire.
      await sql`
        CREATE TABLE IF NOT EXISTS growth_submissions (
          id UUID PRIMARY KEY,
          discord_message_id TEXT NOT NULL UNIQUE,
          discord_user_id TEXT NOT NULL,
          discord_username TEXT,
          ign TEXT NOT NULL,
          class TEXT NOT NULL,
          guild_name TEXT,
          image_data BYTEA NOT NULL,
          image_content_type TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // guild_name was added after growth_submissions first shipped --
      // nullable since old rows predate it, but the bot always sends one now.
      await sql`ALTER TABLE growth_submissions ADD COLUMN IF NOT EXISTS guild_name TEXT`;
      // Was NOT NULL -- the Discord bot always sends a screenshot, but an
      // admin manually adding/editing an entry shouldn't have to have one on
      // hand just to nudge a number. Still required on the bot route itself.
      await sql`ALTER TABLE growth_submissions ALTER COLUMN image_data DROP NOT NULL`;
      await sql`ALTER TABLE growth_submissions ALTER COLUMN image_content_type DROP NOT NULL`;
      // The Volcano Lamp's enhancement level (the "+N" shown next to it in
      // the Artifacts tab) -- same nullable-for-old-rows reasoning as
      // guild_name above.
      await sql`ALTER TABLE growth_submissions ADD COLUMN IF NOT EXISTS lamp_level INTEGER`;
      // The "Growth Rate" stat itself (the big number at the top of the
      // Character Details panel) -- BIGINT since it only ever grows and can
      // get large. Same nullable-for-old-rows reasoning as the columns above.
      await sql`ALTER TABLE growth_submissions ADD COLUMN IF NOT EXISTS growth_rate BIGINT`;

      // One row per World Boss kill/attempt logged -- attendees live in
      // their own table (world_boss_attendees) so an event can have any
      // number of them.
      await sql`
        CREATE TABLE IF NOT EXISTS world_boss_attendance (
          id UUID PRIMARY KEY,
          boss_name TEXT NOT NULL,
          event_date TIMESTAMP NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Was DATE (day only) -- widened to a full timestamp so a kill can
      // record what time it happened, not just which day. Deliberately
      // TIMESTAMP (no time zone), not TIMESTAMPTZ: the value is the admin's
      // own wall-clock input from a <input type="datetime-local">, stored
      // and read back exactly as typed with no UTC conversion -- avoids the
      // day silently shifting for anyone logging a kill late at night in a
      // timezone behind/ahead of the database's, since every other date in
      // this app already treats the calendar day as the literal string date
      // (see formatLongDate) rather than converting between zones. Existing
      // rows convert to midnight since they never had a time to begin with.
      await sql`ALTER TABLE world_boss_attendance ALTER COLUMN event_date TYPE TIMESTAMP USING event_date::timestamp`;
      // Free-text notes on what dropped -- added after this table first
      // shipped, so nullable/optional like everything else added later.
      await sql`ALTER TABLE world_boss_attendance ADD COLUMN IF NOT EXISTS loot TEXT`;
      // Which independent schedule this event belongs to -- e.g. 'world_boss'
      // (the original) vs 'bf4' -- so a second boss-attendance tracker can
      // share the same tables/queries/UI code instead of duplicating all of
      // it, while still keeping its calendar/log/loot fully separate: every
      // query that lists/aggregates events is scoped to one schedule at a
      // time on the client, and rows never cross between schedules.
      await sql`ALTER TABLE world_boss_attendance ADD COLUMN IF NOT EXISTS schedule TEXT NOT NULL DEFAULT 'world_boss'`;
      // Whether the fight was won or lost -- 'pending' for events logged
      // before this existed (or not yet marked either way). Either outcome
      // can carry bonus points (an admin's call either way, e.g. a
      // consolation bonus for a loss or an extra reward for a win) --
      // see world_boss_bonus_points below.
      await sql`ALTER TABLE world_boss_attendance ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'pending'`;
      // One row per attendee awarded a bonus for a win/lose event -- tied to
      // the specific event (not just a bare running total) so the award is
      // auditable back to which fight it came from, and re-saving the event
      // (attendee list, result, or amount changed) can cleanly delete and
      // reinsert this event's rows rather than trying to diff them.
      await sql`
        CREATE TABLE IF NOT EXISTS world_boss_bonus_points (
          id UUID PRIMARY KEY,
          attendance_id UUID NOT NULL REFERENCES world_boss_attendance(id) ON DELETE CASCADE,
          member_name TEXT NOT NULL,
          points NUMERIC NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // A standing list of accounting/management cuts for the World Boss
      // salary computation -- each entry's percent is taken off the top of
      // the Final Pool before the rest is split by Norm. Share, then added
      // back on top of that IGN's own Initial Computation (so total payouts
      // still add up to exactly the pool). Not tied to any one month/pool,
      // unlike the computation itself.
      await sql`
        CREATE TABLE IF NOT EXISTS world_boss_management_fees (
          id UUID PRIMARY KEY,
          ign TEXT NOT NULL UNIQUE,
          percent NUMERIC NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // guild_name is denormalized at record time (like crusade_fees.guild_name
      // elsewhere) so a member's later guild change doesn't rewrite history.
      await sql`
        CREATE TABLE IF NOT EXISTS world_boss_attendees (
          id UUID PRIMARY KEY,
          attendance_id UUID NOT NULL REFERENCES world_boss_attendance(id) ON DELETE CASCADE,
          member_name TEXT NOT NULL,
          guild_name TEXT
        )
      `;
      // Structured loot rows (superseding the old free-text loot column
      // above) so the monthly loot view can show real Item/Quantity/Value
      // columns instead of parsing free text. An event can drop any number
      // of items, hence its own table like world_boss_attendees.
      await sql`
        CREATE TABLE IF NOT EXISTS world_boss_loot_items (
          id UUID PRIMARY KEY,
          attendance_id UUID NOT NULL REFERENCES world_boss_attendance(id) ON DELETE CASCADE,
          item_name TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          crows_value NUMERIC,
          diamonds_value NUMERIC,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Was BIGINT (whole numbers only) -- switched to NUMERIC so an admin
      // splitting one sale's total across several kills isn't forced to
      // round each kill's share to a whole number.
      await sql`ALTER TABLE world_boss_loot_items ALTER COLUMN crows_value TYPE NUMERIC`;
      await sql`ALTER TABLE world_boss_loot_items ALTER COLUMN diamonds_value TYPE NUMERIC`;
      // Whether this specific drop has been sold yet -- per individual drop
      // (not per item name), since two copies of the same item can have
      // different outcomes.
      await sql`ALTER TABLE world_boss_loot_items ADD COLUMN IF NOT EXISTS sold BOOLEAN NOT NULL DEFAULT false`;
      // How much of this drop's quantity has actually sold (0..quantity) --
      // `sold` alone can only say all-or-nothing, but FIFO-matching a kill
      // against sale batches (see applyFifoSalesToItem) can legitimately
      // land on a partial amount, e.g. a kill of quantity 2 when only 1
      // unit's worth of sales is left to allocate to it. `sold` stays in
      // sync as sold_quantity >= quantity (fully sold); a manual toggle
      // only ever sets this to the full quantity or 0, never a partial --
      // partial only ever comes from the automatic matching.
      await sql`ALTER TABLE world_boss_loot_items ADD COLUMN IF NOT EXISTS sold_quantity NUMERIC`;
      await sql`UPDATE world_boss_loot_items SET sold_quantity = quantity WHERE sold = true AND sold_quantity IS NULL`;
      await sql`UPDATE world_boss_loot_items SET sold_quantity = 0 WHERE sold = false AND sold_quantity IS NULL`;
      // Which World Boss drops a given item -- a manually-set fact about the
      // item itself (admin picks it from a dropdown), not derived from
      // whichever kill happened to log it, since a merged monthly-loot row
      // can span multiple kills/bosses and one of them logging it first
      // shouldn't be assumed to be its only source. Keyed by the same
      // lowercased/whitespace-collapsed name the monthly loot view already
      // merges items on.
      await sql`
        CREATE TABLE IF NOT EXISTS loot_item_sources (
          item_key TEXT PRIMARY KEY,
          item_name TEXT NOT NULL,
          boss_name TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Same item name could in principle exist under two different
      // schedules (e.g. 'world_boss' and 'bf4') with a different drop
      // source each -- widen the key to (item_key, schedule) so they don't
      // collide, defaulting existing rows to 'world_boss'.
      await sql`ALTER TABLE loot_item_sources ADD COLUMN IF NOT EXISTS schedule TEXT NOT NULL DEFAULT 'world_boss'`;
      await sql`ALTER TABLE loot_item_sources DROP CONSTRAINT IF EXISTS loot_item_sources_pkey`;
      await sql`ALTER TABLE loot_item_sources ADD CONSTRAINT loot_item_sources_pkey PRIMARY KEY (item_key, schedule)`;
      // A sale is its own record, independent of which kill(s) the sold
      // pieces actually dropped from -- an item's Total Quantity is the sum
      // of every drop across all kills, and a sale batch just consumes some
      // of that pool at a price of its own. This is deliberately decoupled
      // from world_boss_loot_items so that selling 14 pieces at one price
      // and later selling more of the same item at a different price never
      // has to fight over which specific kill's row "owns" the price.
      await sql`
        CREATE TABLE IF NOT EXISTS loot_sale_batches (
          id UUID PRIMARY KEY,
          item_key TEXT NOT NULL,
          item_name TEXT NOT NULL,
          quantity NUMERIC NOT NULL,
          crows_value NUMERIC,
          diamonds_value NUMERIC,
          sold_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`ALTER TABLE loot_sale_batches ADD COLUMN IF NOT EXISTS schedule TEXT NOT NULL DEFAULT 'world_boss'`;
      // Set only when this sale came from directly toggling one specific
      // kill's own Sold status (with its own price already typed in), as
      // opposed to a batch entered through the Sales section's own "+ Add
      // Sale" form, which isn't tied to any one kill. Lets the frontend
      // treat that kill as individually settled -- excluded from the
      // generic FIFO matching that spreads other (unlinked) sales across
      // whichever kills aren't already accounted for -- and find the right
      // sale to remove again if the kill gets toggled back to Not Sold.
      // Cascades with the event since a sale that only exists because of
      // one specific kill shouldn't outlive it.
      await sql`ALTER TABLE loot_sale_batches ADD COLUMN IF NOT EXISTS source_attendance_id UUID REFERENCES world_boss_attendance(id) ON DELETE CASCADE`;

      // Balthazard split off the World Boss schedule into its own tab (see
      // WORLD_BOSS_SCHEDULES) -- move any attendance already logged as a
      // World Boss kill of Balthazard over to its new schedule so past
      // records aren't stranded behind the old tab. Idempotent: once moved,
      // nothing matches `schedule = 'world_boss' AND boss_name = 'Balthazard'`
      // on a later startup.
      await sql`
        UPDATE world_boss_attendance
        SET schedule = 'balthazard'
        WHERE schedule = 'world_boss' AND boss_name = 'Balthazard'
      `;
      // Carry a sale batch tied directly to one of those moved kills (a
      // "locked" sale from toggling an individual drop's Sold status) along
      // with it, so it stays linked to the kill's new schedule.
      await sql`
        UPDATE loot_sale_batches b
        SET schedule = 'balthazard'
        FROM world_boss_attendance a
        WHERE b.source_attendance_id = a.id AND a.schedule = 'balthazard' AND b.schedule = 'world_boss'
      `;
      // Generic (unlinked) sale batches and drop-source annotations are
      // keyed by item name, not by event -- only move one over if every
      // kill that ever dropped that item is now Balthazard's, so an item
      // shared with another World Boss is never split incorrectly.
      await sql`
        UPDATE loot_sale_batches b
        SET schedule = 'balthazard'
        WHERE b.schedule = 'world_boss'
          AND b.source_attendance_id IS NULL
          AND EXISTS (
            SELECT 1 FROM world_boss_loot_items li
            JOIN world_boss_attendance a ON a.id = li.attendance_id
            WHERE lower(regexp_replace(trim(li.item_name), '\s+', ' ', 'g')) = b.item_key AND a.schedule = 'balthazard'
          )
          AND NOT EXISTS (
            SELECT 1 FROM world_boss_loot_items li
            JOIN world_boss_attendance a ON a.id = li.attendance_id
            WHERE lower(regexp_replace(trim(li.item_name), '\s+', ' ', 'g')) = b.item_key AND a.schedule = 'world_boss'
          )
      `;
      await sql`
        UPDATE loot_item_sources s
        SET schedule = 'balthazard'
        WHERE s.schedule = 'world_boss'
          AND EXISTS (
            SELECT 1 FROM world_boss_loot_items li
            JOIN world_boss_attendance a ON a.id = li.attendance_id
            WHERE lower(regexp_replace(trim(li.item_name), '\s+', ' ', 'g')) = s.item_key AND a.schedule = 'balthazard'
          )
          AND NOT EXISTS (
            SELECT 1 FROM world_boss_loot_items li
            JOIN world_boss_attendance a ON a.id = li.attendance_id
            WHERE lower(regexp_replace(trim(li.item_name), '\s+', ' ', 'g')) = s.item_key AND a.schedule = 'world_boss'
          )
      `;

      // An item name shared across the Balthazard/World Boss split (e.g.
      // dropped by both Stormid of Onrush and Balthazard) had its sale
      // batches pooled together under 'world_boss' pre-split and correctly
      // FIFO-matched to each kill -- each kill's own Sold value is still
      // right. But the Balthazard-split migration above only reassigns a
      // batch when EVERY kill of that item moved to the new schedule; here
      // one kill stayed in world_boss, so both batches stayed too, leaving
      // Balthazard's kill with the right per-kill number but no batch of
      // its own, and World Boss's aggregate double-counting a sale that no
      // longer belongs entirely to it. Retire the old pooled (unlinked)
      // batches for any item now split across more than one schedule so
      // the backfill below can regenerate one linked batch per kill,
      // correctly attributed to each kill's own current schedule.
      await sql`
        DELETE FROM loot_sale_batches b
        WHERE b.source_attendance_id IS NULL
          AND (
            SELECT COUNT(DISTINCT a.schedule)
            FROM world_boss_loot_items li
            JOIN world_boss_attendance a ON a.id = li.attendance_id
            WHERE lower(regexp_replace(trim(li.item_name), '\s+', ' ', 'g')) = b.item_key
          ) > 1
      `;

      // Correction for a mistake in the backfill below: its first version
      // only checked for a *linked* batch on the exact kill, missing that a
      // *generic* (unlinked) batch could already fully explain the same
      // kill's Sold status -- e.g. from a manual "+ Add Sale" entered before
      // toggleLootItemSold started linking batches. That inserted a
      // duplicate on top of the real one, double-counting the sale. Remove
      // any 'system-backfill' batch that duplicates an item+schedule which
      // already had a real (non-backfill) batch at the time it ran.
      await sql`
        DELETE FROM loot_sale_batches b
        WHERE b.created_by = 'system-backfill'
          AND EXISTS (
            SELECT 1 FROM loot_sale_batches other
            WHERE other.item_key = b.item_key AND other.schedule = b.schedule
              AND other.id != b.id AND other.created_by != 'system-backfill'
          )
      `;
      // Backfill: a kill marked Sold (with its own Crows/Diamonds already
      // typed in) before toggleLootItemSold started creating a linked
      // loot_sale_batches row for it never got one -- so it still shows
      // "Sold" on the kill itself, but the item's Sales summary (which only
      // counts real batches) sees nothing and says 0 sold. Synthesize the
      // missing batch from the kill's own already-stored values so the two
      // views agree, without changing anything already on the kill. Only
      // inserts where that item+schedule has NO sale batch at all yet (not
      // just no *linked* one -- an existing generic/unlinked batch can
      // already fully explain the same kill, and stacking a second one on
      // top would double-count it), so this is idempotent and never
      // duplicates a batch on a later startup.
      await sql`
        INSERT INTO loot_sale_batches (id, item_key, item_name, schedule, quantity, crows_value, diamonds_value, sold_at, created_by, source_attendance_id)
        SELECT
          gen_random_uuid(),
          lower(regexp_replace(trim(li.item_name), '\s+', ' ', 'g')),
          li.item_name,
          COALESCE(a.schedule, 'world_boss'),
          COALESCE(li.sold_quantity, CASE WHEN li.sold THEN li.quantity ELSE 0 END),
          li.crows_value,
          li.diamonds_value,
          li.created_at,
          'system-backfill',
          li.attendance_id
        FROM world_boss_loot_items li
        JOIN world_boss_attendance a ON a.id = li.attendance_id
        WHERE (li.sold OR COALESCE(li.sold_quantity, 0) > 0)
          AND COALESCE(li.sold_quantity, CASE WHEN li.sold THEN li.quantity ELSE 0 END) > 0
          AND NOT EXISTS (
            SELECT 1 FROM loot_sale_batches b
            WHERE b.schedule = COALESCE(a.schedule, 'world_boss')
              AND b.item_key = lower(regexp_replace(trim(li.item_name), '\s+', ' ', 'g'))
          )
      `;
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

module.exports = { sql, sqlTransaction, ensureSchema, hashPassword, verifyPassword };
