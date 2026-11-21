// Saves a Discord /attendance scan as a World Boss / Balthazard attendance
// record -- the same rows the site's "Log Attendance" form writes
// (POST /api/world-boss-attendance in lib/app.js), so it shows up on the
// #worldboss / #balthazard pages like any other kill.
const crypto = require('crypto');
const { sql, sqlTransaction } = require('./db');
const { EXTRA_ITEM_NAMES } = require('./extraItems');

// event_date is stored as a wall-clock time with no timezone (the site
// saves whatever an admin types). The guild plays on Philippines time, so
// the bot writes PH clock times too.
const GUILD_UTC_OFFSET_MINUTES = 8 * 60;
const GUILD_TZ_LABEL = 'UTC+8';

// A second /attendance for the same boss within this window is taken to be
// another screenshot of the same kill: its names are added to that record.
const SAME_FIGHT_MINUTES = 30;

const pad = (n) => String(n).padStart(2, '0');

// Wall-clock parts of a UTC instant on the guild's clock.
function guildClock(date) {
  const d = new Date(date.getTime() + GUILD_UTC_OFFSET_MINUTES * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/**
 * A moment (e.g. when the screenshots were uploaded) as the kill time on
 * the guild's clock, to the minute.
 * @returns {{ wall: string, unix: number }} wall is "YYYY-MM-DDTHH:MM" (the
 *   site's own event_date format), unix the same minute as a Unix
 *   timestamp, for Discord's <t:...> display.
 */
function resolveEventTime(moment = new Date()) {
  const { y, mo, d, h, mi } = guildClock(moment);
  const wall = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;
  return { wall, unix: wallToUnix(wall) };
}

// "YYYY-MM-DDTHH:MM" on the guild's clock -> Unix timestamp.
function wallToUnix(wall) {
  const [, y, mo, d, h, mi] = String(wall).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/).map(Number);
  return Math.floor((Date.UTC(y, mo - 1, d, h, mi) - GUILD_UTC_OFFSET_MINUTES * 60000) / 1000);
}

// Back from a Discord timestamp (<t:unix:F> on an attendance post) to the
// guild's wall-clock time, "2026-11-19T05:25".
function unixToWall(unix) {
  return new Date(Number(unix) * 1000 + GUILD_UTC_OFFSET_MINUTES * 60000).toISOString().slice(0, 16);
}

// Each attendee's guild from their Growth Rate entry -- same lookup the
// site's own route does (resolveAttendeeGuilds in lib/app.js).
async function guildsFor(names) {
  if (!names.length) return new Map();
  const { rows } = await sql`SELECT DISTINCT ON (LOWER(ign)) ign, guild_name FROM growth_submissions WHERE LOWER(ign) = ANY(${names.map((n) => n.toLowerCase())}) ORDER BY LOWER(ign), updated_at DESC`;
  const byLower = new Map(rows.map((r) => [r.ign.toLowerCase(), r.guild_name]));
  return new Map(names.map((n) => [n, byLower.get(n.toLowerCase()) || null]));
}

/**
 * Saves the attendees, either as a new record or -- if this boss already has
 * a record within SAME_FIGHT_MINUTES of `wall` -- added onto that one.
 * New records start as result "pending"; admins set Win/Lose on the site.
 * @param {{ schedule: string, boss: string }} boss  from findBossInText
 * @returns {Promise<{ id: string, merged: boolean, added: number, total: number, wall: string }>}
 */
// The record for this boss closest to `wall`, within SAME_FIGHT_MINUTES.
async function findSameFight(boss, wall) {
  const { rows } = await sql`
    SELECT id, to_char(event_date, 'YYYY-MM-DD"T"HH24:MI') AS wall FROM world_boss_attendance
    WHERE schedule = ${boss.schedule} AND boss_name = ${boss.boss}
      AND event_date BETWEEN ${wall}::timestamp - make_interval(mins => ${SAME_FIGHT_MINUTES}) AND ${wall}::timestamp + make_interval(mins => ${SAME_FIGHT_MINUTES})
    ORDER BY ABS(EXTRACT(EPOCH FROM (event_date - ${wall}::timestamp)))
    LIMIT 1
  `;
  return rows[0] || null;
}

async function logBotActivity({ loggedBy, action, id, description, after }) {
  try {
    await sql`
      INSERT INTO activity_log (id, user_id, username, role, action, entity_type, entity_id, description, after_data)
      VALUES (${crypto.randomUUID()}, ${null}, ${`${loggedBy} (Discord)`}, 'bot', ${action}, 'world_boss_attendance', ${id}, ${description}, ${JSON.stringify(after)})
    `;
  } catch (err) {
    console.error('Could not write the attendance activity log entry:', err);
  }
}

/**
 * Takes members off a kill's record (someone added by mistake), and their
 * bonus points for that kill if it has any. Like an admin's edit on the
 * site, this also tells the trainer a scan's guess was wrong.
 * @returns {Promise<{ removed: string[], total: number } | null>} null when no record
 */
async function removeAttendees({ boss, wall, names, loggedBy }) {
  const existing = await findSameFight(boss, wall);
  if (!existing) return null;
  const id = existing.id;
  const lower = names.map((n) => n.trim().toLowerCase());
  const { rows } = await sql`
    DELETE FROM world_boss_attendees
    WHERE attendance_id = ${id} AND LOWER(TRIM(member_name)) = ANY(${lower})
    RETURNING member_name
  `;
  await sql`DELETE FROM world_boss_bonus_points WHERE attendance_id = ${id} AND LOWER(TRIM(member_name)) = ANY(${lower})`;
  const removed = rows.map((r) => r.member_name);
  const { rows: countRows } = await sql`SELECT COUNT(*)::int AS n FROM world_boss_attendees WHERE attendance_id = ${id}`;
  if (removed.length) await logBotActivity({
    loggedBy,
    action: 'update',
    id,
    description: `Discord /attendance removed ${removed.length} attendee${removed.length === 1 ? '' : 's'} from ${boss.boss} on ${existing.wall.replace('T', ' ')}`,
    after: { bossName: boss.boss, schedule: boss.schedule, eventDate: existing.wall, removed },
  });
  return { removed, total: countRows[0].n };
}

// Item names on the site with how often each boss dropped them -- what
// cut-off names from the loot list are completed against (lootMatch.js).
async function loadKnownItems() {
  const { rows } = await sql`
    SELECT li.item_name AS name, a.boss_name AS boss, COUNT(*)::int AS count
    FROM world_boss_loot_items li JOIN world_boss_attendance a ON a.id = li.attendance_id
    GROUP BY li.item_name, a.boss_name
  `;
  // Plus the hand-added full names (lib/extraItems.js) not on any record yet.
  const have = new Set(rows.map((r) => r.name.trim().toLowerCase()));
  const extra = EXTRA_ITEM_NAMES.filter((n) => !have.has(n.toLowerCase())).map((name) => ({ name, boss: '', count: 0 }));
  return [...rows, ...extra];
}

/**
 * Puts one kill's loot (read off the loot list) on its record: the record
 * for that boss within SAME_FIGHT_MINUTES of the kill time, or a new
 * pending record if /attendance hasn't made one yet (its names get added
 * when it does). Items the record doesn't have yet are added; items it
 * already has (by name) are left alone -- the same loot list posted twice
 * must not count the drops twice. An admin fixes quantities on the site.
 * @param {Array<{ name: string, quantity: number }>} items  already totaled per name
 * @returns {Promise<{ id: string, created: boolean, added: number, alreadyThere: number, wall: string }>}
 *   added / alreadyThere count item kinds
 */
async function saveLootToRecord({ boss, wall, items: scanned, loggedBy }) {
  const existing = await findSameFight(boss, wall);
  const id = existing ? existing.id : crypto.randomUUID();
  const recordWall = existing ? existing.wall : wall;
  let items = scanned;
  if (existing) {
    const { rows } = await sql`SELECT item_name FROM world_boss_loot_items WHERE attendance_id = ${id}`;
    const have = new Set(rows.map((r) => r.item_name.trim().toLowerCase()));
    items = scanned.filter((i) => !have.has(i.name.trim().toLowerCase()));
    if (!items.length) return { id, created: false, added: 0, alreadyThere: scanned.length, wall: recordWall };
  } else {
    await sql`INSERT INTO world_boss_attendance (id, boss_name, event_date, schedule, result) VALUES (${id}, ${boss.boss}, ${wall}, ${boss.schedule}, 'pending')`;
  }
  for (const item of items) {
    await sql`
      INSERT INTO world_boss_loot_items (id, attendance_id, item_name, quantity, crows_value, diamonds_value, sold, sold_quantity)
      VALUES (${crypto.randomUUID()}, ${id}, ${item.name}, ${item.quantity}, ${null}, ${null}, ${false}, ${0})
    `;
  }
  const total = items.reduce((s, i) => s + i.quantity, 0);
  await logBotActivity({
    loggedBy,
    action: existing ? 'update' : 'create',
    id,
    description: `Discord /attendance added ${total} loot item${total === 1 ? '' : 's'} (${items.length} kind${items.length === 1 ? '' : 's'}) to ${boss.boss} on ${recordWall.replace('T', ' ')}`,
    after: { bossName: boss.boss, schedule: boss.schedule, eventDate: recordWall, lootItems: items },
  });
  return { id, created: !existing, added: items.length, alreadyThere: scanned.length - items.length, wall: recordWall };
}

async function saveAttendanceRecord({ boss, wall, names, loggedBy }) {
  const unique = [...new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()])).values()].filter(Boolean);

  const existing = await findSameFight(boss, wall);
  const id = existing ? existing.id : crypto.randomUUID();
  let toAdd = unique;
  if (existing) {
    const { rows } = await sql`SELECT member_name FROM world_boss_attendees WHERE attendance_id = ${id}`;
    const have = new Set(rows.map((r) => r.member_name.trim().toLowerCase()));
    toAdd = unique.filter((n) => !have.has(n.toLowerCase()));
  } else {
    await sql`INSERT INTO world_boss_attendance (id, boss_name, event_date, schedule, result) VALUES (${id}, ${boss.boss}, ${wall}, ${boss.schedule}, 'pending')`;
  }

  const guilds = await guildsFor(toAdd);
  for (const name of toAdd) {
    await sql`INSERT INTO world_boss_attendees (id, attendance_id, member_name, guild_name) VALUES (${crypto.randomUUID()}, ${id}, ${name}, ${guilds.get(name) || null})`;
  }
  const { rows: countRows } = await sql`SELECT COUNT(*)::int AS n FROM world_boss_attendees WHERE attendance_id = ${id}`;
  const recordWall = existing ? existing.wall : wall;

  // Shows on the site's Activity Log like an admin's own edits, as the bot
  // (not for a re-post that added nobody).
  const n = `${toAdd.length} attendee${toAdd.length === 1 ? '' : 's'}`;
  if (toAdd.length) await logBotActivity({
    loggedBy,
    action: existing ? 'update' : 'create',
    id,
    description: existing ? `Discord /attendance added ${n} to ${boss.boss} on ${recordWall.replace('T', ' ')}` : `Discord /attendance logged ${n} for ${boss.boss} on ${recordWall.replace('T', ' ')}`,
    after: { bossName: boss.boss, schedule: boss.schedule, eventDate: recordWall, added: toAdd },
  });

  return { id, merged: Boolean(existing), added: toAdd.length, total: countRows[0].n, wall: recordWall };
}

/**
 * Rescan: replaces the saved attendees (and, when safe, the loot) of this
 * kill's record with a fresh scan -- for correcting a wrong scan. Same as
 * the site's own edit (PUT /api/world-boss-attendance/:id): the names are
 * swapped wholesale and bonus points, if the kill has any, are recomputed
 * for the new names. Loot is only replaced while none of it has a price or
 * a sale recorded; otherwise it's kept so sales data is never lost.
 * With no record for this kill yet, it's simply a normal first save.
 * @returns {Promise<{ id: string, created: boolean, total: number, lootReplaced: boolean, lootKept: boolean }>}
 */
async function replaceAttendanceRecord({ boss, wall, names, items, loggedBy }) {
  const existing = await findSameFight(boss, wall);
  if (!existing) {
    const saved = await saveAttendanceRecord({ boss, wall, names, loggedBy });
    if (items.length) await saveLootToRecord({ boss, wall, items, loggedBy });
    return { id: saved.id, created: true, total: saved.total, lootReplaced: items.length > 0, lootKept: false };
  }
  const id = existing.id;
  const unique = [...new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()])).values()].filter(Boolean);
  const { rows: beforeNames } = await sql`SELECT member_name FROM world_boss_attendees WHERE attendance_id = ${id}`;
  const { rows: beforeLoot } = await sql`SELECT item_name, quantity, crows_value, diamonds_value, sold, sold_quantity FROM world_boss_loot_items WHERE attendance_id = ${id}`;
  const { rows: bonusRows } = await sql`SELECT points FROM world_boss_bonus_points WHERE attendance_id = ${id} LIMIT 1`;

  const queries = [];
  if (unique.length) {
    const guilds = await guildsFor(unique);
    queries.push(sql`DELETE FROM world_boss_attendees WHERE attendance_id = ${id}`);
    for (const name of unique) {
      queries.push(sql`INSERT INTO world_boss_attendees (id, attendance_id, member_name, guild_name) VALUES (${crypto.randomUUID()}, ${id}, ${name}, ${guilds.get(name) || null})`);
    }
    if (bonusRows.length) {
      queries.push(sql`DELETE FROM world_boss_bonus_points WHERE attendance_id = ${id}`);
      for (const name of unique) {
        queries.push(sql`INSERT INTO world_boss_bonus_points (id, attendance_id, member_name, points) VALUES (${crypto.randomUUID()}, ${id}, ${name}, ${bonusRows[0].points})`);
      }
    }
  }
  const lootHasSales = beforeLoot.some((l) => l.sold || Number(l.sold_quantity) > 0 || l.crows_value !== null || l.diamonds_value !== null);
  const replaceLoot = items.length > 0 && !lootHasSales;
  if (replaceLoot) {
    queries.push(sql`DELETE FROM world_boss_loot_items WHERE attendance_id = ${id}`);
    for (const item of items) {
      queries.push(sql`
        INSERT INTO world_boss_loot_items (id, attendance_id, item_name, quantity, crows_value, diamonds_value, sold, sold_quantity)
        VALUES (${crypto.randomUUID()}, ${id}, ${item.name}, ${item.quantity}, ${null}, ${null}, ${false}, ${0})
      `);
    }
  }
  // One transaction: a failure halfway never leaves a record half-replaced.
  if (queries.length) await sqlTransaction(queries);

  await logBotActivity({
    loggedBy,
    action: 'update',
    id,
    description: `Discord /attendance rescan replaced ${unique.length ? `the attendees (${unique.length})` : 'nothing in the attendees'}${replaceLoot ? ' and the loot' : ''} of ${boss.boss} on ${existing.wall.replace('T', ' ')}`,
    after: {
      before: { attendees: beforeNames.map((r) => r.member_name), lootItems: beforeLoot },
      after: { attendees: unique.length ? unique : beforeNames.map((r) => r.member_name), lootItems: replaceLoot ? items : beforeLoot },
    },
  });
  const { rows: countRows } = await sql`SELECT COUNT(*)::int AS n FROM world_boss_attendees WHERE attendance_id = ${id}`;
  return { id, created: false, total: countRows[0].n, lootReplaced: replaceLoot, lootKept: items.length > 0 && lootHasSales };
}

module.exports = { resolveEventTime, saveAttendanceRecord, saveLootToRecord, replaceAttendanceRecord, loadKnownItems, wallToUnix, unixToWall, removeAttendees, GUILD_TZ_LABEL };
