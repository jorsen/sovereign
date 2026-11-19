// Saves a Discord /attendance scan as a World Boss / Balthazard attendance
// record -- the same rows the site's "Log Attendance" form writes
// (POST /api/world-boss-attendance in lib/app.js), so it shows up on the
// #worldboss / #balthazard pages like any other kill.
const crypto = require('crypto');
const { sql } = require('./db');

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
 * Works out when the kill happened, on the guild's clock. Both inputs are
 * optional /attendance fields; left empty, they default to now.
 *   time: "21:30", "9:30pm", "9pm", "2130"
 *   date: "2026-11-20", "11/20", "11-20", "20/11" isn't supported (month first)
 * @returns {{ wall: string, unix: number } | { error: 'badDate' | 'badTime' }}
 *   wall is "YYYY-MM-DDTHH:MM" (the site's own event_date format), unix is
 *   the same moment as a Unix timestamp, for Discord's <t:...> display.
 */
function resolveEventTime({ date, time } = {}, now = new Date()) {
  const today = guildClock(now);
  let { y, mo, d, h, mi } = today;

  if (date && String(date).trim()) {
    const s = String(date).trim();
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/))) [mo, d] = [Number(m[1]), Number(m[2])];
    else return { error: 'badDate' };
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return { error: 'badDate' };
  }

  if (time && String(time).trim()) {
    const s = String(time).trim().toLowerCase().replace(/\s+/g, '');
    const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/);
    if (!m) return { error: 'badTime' };
    h = Number(m[1]);
    mi = m[2] ? Number(m[2]) : 0;
    if (m[3]) {
      if (h < 1 || h > 12) return { error: 'badTime' };
      h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
    }
    if (h > 23 || mi > 59) return { error: 'badTime' };
  }

  const unix = Math.floor((Date.UTC(y, mo - 1, d, h, mi) - GUILD_UTC_OFFSET_MINUTES * 60000) / 1000);
  return { wall: `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`, unix };
}

// "YYYY-MM-DDTHH:MM" on the guild's clock -> Unix timestamp.
function wallToUnix(wall) {
  const [, y, mo, d, h, mi] = String(wall).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/).map(Number);
  return Math.floor((Date.UTC(y, mo - 1, d, h, mi) - GUILD_UTC_OFFSET_MINUTES * 60000) / 1000);
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
async function saveAttendanceRecord({ boss, wall, names, loggedBy }) {
  const unique = [...new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()])).values()].filter(Boolean);

  const { rows: nearby } = await sql`
    SELECT id, to_char(event_date, 'YYYY-MM-DD"T"HH24:MI') AS wall FROM world_boss_attendance
    WHERE schedule = ${boss.schedule} AND boss_name = ${boss.boss}
      AND event_date BETWEEN ${wall}::timestamp - make_interval(mins => ${SAME_FIGHT_MINUTES}) AND ${wall}::timestamp + make_interval(mins => ${SAME_FIGHT_MINUTES})
    ORDER BY ABS(EXTRACT(EPOCH FROM (event_date - ${wall}::timestamp)))
    LIMIT 1
  `;
  const existing = nearby[0];
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

  // Shows on the site's Activity Log like an admin's own edits, as the bot.
  try {
    await sql`
      INSERT INTO activity_log (id, user_id, username, role, action, entity_type, entity_id, description, after_data)
      VALUES (${crypto.randomUUID()}, ${null}, ${`${loggedBy} (Discord)`}, 'bot', ${existing ? 'update' : 'create'}, 'world_boss_attendance', ${id},
        ${existing
          ? `Discord /attendance added ${toAdd.length} attendee${toAdd.length === 1 ? '' : 's'} to ${boss.boss} on ${recordWall.replace('T', ' ')}`
          : `Discord /attendance logged ${toAdd.length} attendee${toAdd.length === 1 ? '' : 's'} for ${boss.boss} on ${recordWall.replace('T', ' ')}`},
        ${JSON.stringify({ bossName: boss.boss, schedule: boss.schedule, eventDate: recordWall, added: toAdd })})
    `;
  } catch (err) {
    console.error('Could not write the attendance activity log entry:', err);
  }

  return { id, merged: Boolean(existing), added: toAdd.length, total: countRows[0].n, wall: recordWall };
}

module.exports = { resolveEventTime, saveAttendanceRecord, wallToUnix, GUILD_TZ_LABEL };
