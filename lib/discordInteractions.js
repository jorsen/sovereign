// Handles /uniongr entirely over Discord's HTTP Interactions Endpoint --
// no Gateway connection, no separate always-running bot process. Discord
// POSTs the interaction straight to this route; we verify it's really from
// Discord, ack it within 3 seconds (privately, "thinking..."), then do the
// actual work (download the screenshot, save the submission) and edit that
// same private reply with either a "Saved" confirmation (plus a ✅ reaction
// on it) or an error. The submitter's own screenshot/stats are never posted
// publicly -- only a short admin-facing "saved, total is now N" text notice
// goes to the channel on success.
//
// Trade-off vs. the old Gateway-based bot (discord-bot/index.js): this can't
// watch every message in the channel, so it can't reject stray chat with a
// guide embed, and it can't clean up a submission when its confirmation post
// is deleted. Both were Gateway-only features. Everything /uniongr itself
// does is preserved.
const { verifyKey } = require('discord-interactions');
const { waitUntil } = require('@vercel/functions');
const sharp = require('sharp');
const crypto = require('crypto');
const { sql, ensureSchema } = require('./db');
const { GROWTH_GUIDE, GROWTH_GUIDE_TITLE, GROWTH_GUIDE_CHANNEL_ID } = require('../discord-bot/growthGuide');
const { readNamesFromScreenshot, mergeNameLists } = require('./attendanceOcr');
const { matchToRoster, nameKey } = require('./rosterMatch');
const { findBossInText, bossTitle, SCANNABLE_BOSSES } = require('./bosses');
const { resolveEventTime, saveAttendanceRecord, saveLootToRecord, replaceAttendanceRecord, loadKnownItems, wallToUnix } = require('./attendanceRecords');
const { readLootList, mergeLootScreenshots } = require('./lootOcr');
const { completeItemName, lootKey } = require('./lootMatch');
const { multi, forLocale } = require('./attendanceText');

// /attendance only answers in the boss-attendance channels, so the name
// lists all land in known places. ATTENDANCE_CHANNEL_ID can list several,
// comma-separated; the first is the one the wrong-channel reply points to.
const ATTENDANCE_CHANNEL_IDS = (process.env.ATTENDANCE_CHANNEL_ID || '1573000319837806622')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const isAttendanceChannel = (id) => ATTENDANCE_CHANNEL_IDS.includes(String(id));
// Kept in sync with register-commands.js's /attendance screenshot options.
const ATTENDANCE_SCREENSHOT_OPTIONS = ['screenshot', 'screenshot2', 'screenshot3', 'screenshot4', 'screenshot5', 'screenshot6', 'screenshot7', 'screenshot8', 'screenshot9', 'screenshot10'];

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const GROWTH_BOT_SECRET = process.env.GROWTH_BOT_SECRET;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// Discord user ids that get a DM for every IGN change
// request, so an admin can verify it without watching the channel --
// override with a comma-separated IGN_CHANGE_DM_USER_IDS env var.
const IGN_CHANGE_DM_USER_IDS = (process.env.IGN_CHANGE_DM_USER_IDS || '408424542810406922').split(',').map((id) => id.trim()).filter(Boolean);

// Kept in sync with register-commands.js's /uniongr choices and with the
// app's own server-side check on POST /api/growth-submissions/bot -- same
// duplication-with-a-comment precedent as discord-bot/index.js used.
const VALID_GUILDS = ['Helloシ', '貓貓客棧', '巫女組', 'CAPITAL', 'BUBBLEGANG'];
const VALID_CLASSES = [
  'Ultimate Martialist',
  'Soul Reaper',
  'Storm Hawkeye',
  'Divine Priest',
  'Mighty Demolisher',
  'Mystic Luminary',
  'Crusader',
  'Bloody Enforcer',
  'Fatal Lord',
  'Eternal Commander',
  'Prime Savior',
  'Grand Wizard',
];
const LAMP_MIN = 1;
const LAMP_MAX = 25;
function isValidLampLevel(n) {
  return Number.isInteger(n) && n >= LAMP_MIN && n <= LAMP_MAX;
}

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

async function compressImageIfNeeded(buffer, contentType) {
  if (buffer.length <= MAX_IMAGE_BYTES) return { buffer, contentType };
  try {
    const resized = await sharp(buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { buffer: resized, contentType: 'image/jpeg' };
  } catch (err) {
    console.error('Failed to compress screenshot, sending original:', err);
    return { buffer, contentType };
  }
}

// Ephemeral rejection/error embed -- only the submitter sees it.
function rejectionEmbed(title, description, whatWeNeed) {
  const embed = { color: 0xe74c3c, title, description };
  if (whatWeNeed) embed.fields = [{ name: 'What we need', value: whatWeNeed }];
  return embed;
}

// Serverless functions occasionally get a socket torn down mid-request
// (fetch throws "terminated") for reasons outside our code -- the
// connection pool being recycled, a brief network hiccup, etc. One retry
// after a short pause resolves those without needing a person to resubmit.
async function fetchWithRetry(url, options, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastErr;
}

// Returns the updated message object (so the caller can react to it) or
// null if Discord rejected the edit.
async function editOriginalResponse(applicationId, token, payload) {
  const res = await fetchWithRetry(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error('editOriginalResponse failed:', res.status, await res.text().catch(() => ''));
    return null;
  }
  return res.json().catch(() => null);
}

// Best-effort -- a missing reaction is a cosmetic miss, not worth failing
// the whole submission over, so failures are logged and swallowed.
async function addReaction(channelId, messageId, emoji) {
  if (!DISCORD_TOKEN || !channelId || !messageId) return;
  try {
    const res = await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    });
    if (!res.ok) console.error('addReaction failed:', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('addReaction threw:', err);
  }
}

// Bot message straight to the channel via the bot token -- used for the
// admin-facing "someone submitted" notice. `payload` is either a plain
// string (sent as `content`) or a full message payload object (e.g. one
// with `embeds`).
async function postChannelMessage(channelId, payload) {
  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set -- cannot post to the channel.');
  const res = await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_TOKEN}` },
    body: JSON.stringify(typeof payload === 'string' ? { content: payload } : payload),
  });
  if (!res.ok) throw new Error(`Discord rejected the channel message (${res.status}): ${await res.text().catch(() => '')}`);
}

// Keeps the /uniongr guide as the newest message in the growth-rate channel:
// deletes the bot's previous bottom copy (the pinned one is left alone) and
// posts it again. Called after every bot post there, so submissions and
// approval notices never push the guide out of view. Best-effort.
async function restickGrowthGuide(channelId) {
  if (!DISCORD_TOKEN || String(channelId) !== GROWTH_GUIDE_CHANNEL_ID) return;
  try {
    const res = await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages?limit=50`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    });
    if (res.ok) {
      const messages = await res.json();
      const oldCopies = messages.filter((m) => m.author?.bot && !m.pinned && m.embeds?.[0]?.title === GROWTH_GUIDE_TITLE);
      for (const m of oldCopies) {
        await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages/${m.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
        });
      }
    }
    await postChannelMessage(channelId, GROWTH_GUIDE);
  } catch (err) {
    console.error('Failed to re-post the growth guide:', err);
  }
}

// DMs one user via the bot token: opens (or reuses) the DM channel, then
// posts to it. Only works while the user shares a server with the bot.
async function sendDirectMessage(userId, payload) {
  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set -- cannot send a DM.');
  const res = await fetchWithRetry('https://discord.com/api/v10/users/@me/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_TOKEN}` },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!res.ok) throw new Error(`Discord refused to open a DM with ${userId} (${res.status}): ${await res.text().catch(() => '')}`);
  const dm = await res.json();
  await postChannelMessage(dm.id, payload);
}

// Splits "1. Name" lines into embed fields under Discord's 1024-char-per-
// field and 25-field limits -- inline so multiple chunks sit side by side
// instead of one long single-column list.
function buildRankedIgnFields(rankedIgns) {
  const lines = rankedIgns.map((name, i) => `${i + 1}. ${name}`);
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const line of lines) {
    if (current.length >= 25 || currentLen + line.length + 1 > 1000) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks.map((chunk, i) => ({
    name: chunks.length > 1 ? `Rankings (${i + 1}/${chunks.length})` : 'Rankings',
    value: chunk.join('\n'),
    inline: true,
  }));
}

// Every rejection/failure gets its own Activity Log row (role "bot", no
// user_id since there's no site account behind a Discord submitter) so
// admins can see failed /uniongr attempts -- not just successful ones --
// without needing to check Vercel's own logs.
async function logBotActivity({ action, description, submitterName, after }) {
  try {
    await sql`
      INSERT INTO activity_log (id, user_id, username, role, action, entity_type, entity_id, description, after_data)
      VALUES (${crypto.randomUUID()}, ${null}, ${submitterName || 'Discord Bot'}, 'bot', ${action}, 'growth_submission', ${null}, ${description}, ${after ? JSON.stringify(after) : null})
    `;
  } catch (err) {
    console.error('Failed to log /uniongr bot activity:', err);
  }
}

// Every member name in the database -- what /attendance corrects OCR
// readings against: each IGN on the Growth Rate page, plus anyone already
// logged in World Boss attendance at least twice who isn't on it (e.g.
// 자본丶ImmorTalヅ). One-off entries and Discord-style nicknames pasted in
// by mistake ("@CAP | 자본丶RevArt") are left out.
async function loadGrowthRateNames() {
  const { rows } = await sql`
    SELECT DISTINCT ON (LOWER(name)) name FROM (
      SELECT TRIM(ign) AS name FROM growth_submissions WHERE TRIM(ign) <> ''
      UNION ALL
      SELECT TRIM(member_name) FROM world_boss_attendees
      WHERE TRIM(member_name) <> '' AND member_name NOT LIKE '%|%' AND member_name NOT LIKE '@%'
      GROUP BY TRIM(member_name) HAVING COUNT(*) >= 2
    ) n
    ORDER BY LOWER(name)
  `;
  return rows.map((r) => r.name);
}

// The trainer: what past scans taught, for rosterMatch.js.
// - memory: every misreading the bot saved as a member (attendance_ocr_matches),
//   counted as right (`good`) while that member is still in the record's
//   attendees, wrong (`bad`) once an admin removed them or a rescan replaced
//   them. Fixing records on the site is what trains it.
// - attendRate: each member's share of World Boss / Balthazard kills over
//   the last 30 days; left out until there are at least 5 kills to go by.
const ATTEND_RATE_DAYS = 30;
const ATTEND_RATE_MIN_KILLS = 5;
async function loadMatchingContext() {
  const { rows: memoryRows } = await sql`
    SELECT m.reading_key, m.member_name,
      COUNT(DISTINCT m.attendance_id) FILTER (WHERE EXISTS (
        SELECT 1 FROM world_boss_attendees wa
        WHERE wa.attendance_id = m.attendance_id AND LOWER(TRIM(wa.member_name)) = LOWER(TRIM(m.member_name))
      ))::int AS good,
      COUNT(DISTINCT m.attendance_id)::int AS total
    FROM attendance_ocr_matches m
    GROUP BY m.reading_key, m.member_name
  `;
  const memory = memoryRows.map((r) => ({ readingKey: r.reading_key, member: r.member_name, good: r.good, bad: r.total - r.good }));

  const { rows: killRows } = await sql`
    SELECT COUNT(*)::int AS n FROM world_boss_attendance
    WHERE schedule IN ('world_boss', 'balthazard') AND event_date >= now() - make_interval(days => ${ATTEND_RATE_DAYS})
  `;
  const kills = killRows[0].n;
  let attendRate;
  if (kills >= ATTEND_RATE_MIN_KILLS) {
    const { rows } = await sql`
      SELECT LOWER(TRIM(wa.member_name)) AS name, COUNT(DISTINCT a.id)::int AS n
      FROM world_boss_attendees wa JOIN world_boss_attendance a ON a.id = wa.attendance_id
      WHERE a.schedule IN ('world_boss', 'balthazard') AND a.event_date >= now() - make_interval(days => ${ATTEND_RATE_DAYS})
      GROUP BY LOWER(TRIM(wa.member_name))
    `;
    attendRate = new Map(rows.map((r) => [r.name, r.n / kills]));
  }
  return { memory, attendRate };
}

// After a save: remembers which misreading each saved member came from
// (only real misreadings -- a name read exactly teaches nothing). The bot
// itself never marks these right or wrong; loadMatchingContext judges them
// by what the record says later. Best-effort: a failure here never affects
// the attendance itself.
async function recordTraining(attendanceId, matches) {
  // 4+ characters only: a scrap like "rm" (of STORM) or "4" (of ─41─) would
  // later turn any junk "RM" into a sure match.
  const rows = (matches || []).filter((n) => n.status === 'corrected' && n.readAs && [...nameKey(n.readAs)].length >= 4 && nameKey(n.readAs) !== nameKey(n.name));
  try {
    for (const n of rows) {
      await sql`INSERT INTO attendance_ocr_matches (id, attendance_id, member_name, reading_key) VALUES (${crypto.randomUUID()}, ${attendanceId}, ${n.name}, ${nameKey(n.readAs)})`;
    }
  } catch (err) {
    console.error('attendance trainer could not record its matches:', err);
  }
}

// Loot trainer: cut-off item names completed before, whose item is still
// on that record (more often than not) -- lootKey -> item name.
async function loadLearnedItems() {
  const { rows } = await sql`
    SELECT l.fragment_key, l.item_name,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM world_boss_loot_items li
        WHERE li.attendance_id = l.attendance_id AND LOWER(TRIM(li.item_name)) = LOWER(TRIM(l.item_name))
      ))::int AS good,
      COUNT(*)::int AS total
    FROM attendance_ocr_loot l
    GROUP BY l.fragment_key, l.item_name
  `;
  const learned = new Map();
  const ambiguous = new Set();
  for (const r of rows) {
    if (r.good <= r.total - r.good || r.fragment_key.length < 4) continue;
    if (learned.has(r.fragment_key) && learned.get(r.fragment_key) !== r.item_name) ambiguous.add(r.fragment_key);
    learned.set(r.fragment_key, r.item_name);
  }
  for (const k of ambiguous) learned.delete(k);
  return learned;
}

// Icons learned per item name (attendance_ocr_icons): rows whose text named
// the item, plus undecided rows ("Enhancement Scroll") once an admin fixed
// the bot's guess on the site: their kill's record then holds exactly one
// of the items they could have been, and not the guess. A guess nobody
// changed teaches nothing -- it would only confirm itself.
const ICONS_PER_ITEM = 20;
async function loadIconLibrary() {
  const { rows } = await sql`
    SELECT i.item_name, i.candidates, i.guess, i.fingerprint,
      (SELECT json_agg(li.item_name) FROM world_boss_loot_items li WHERE i.item_name IS NULL AND li.attendance_id = i.attendance_id) AS on_record
    FROM attendance_ocr_icons i
    ORDER BY i.created_at DESC
    LIMIT 5000
  `;
  const icons = new Map();
  for (const r of rows) {
    let name = r.item_name;
    if (!name) {
      const candidates = JSON.parse(r.candidates || '[]').map((c) => c.toLowerCase());
      const present = [...new Set((r.on_record || []).filter((n) => candidates.includes(String(n).trim().toLowerCase())))];
      if (present.length !== 1 || present[0].trim().toLowerCase() === String(r.guess || '').trim().toLowerCase()) continue;
      name = present[0];
    }
    const list = icons.get(name) || [];
    if (list.length < ICONS_PER_ITEM) list.push(r.fingerprint);
    icons.set(name, list);
  }
  return icons;
}

// After a loot save: each row's icon -- under its item when the text named
// it, or with its candidates (and the guess made, if any) when it couldn't
// be told. Best-effort.
async function recordIconTraining(attendanceId, items) {
  try {
    for (const i of items || []) {
      for (const icon of i.icons || []) {
        if (i.matched && i.byText && i.confident) {
          await sql`INSERT INTO attendance_ocr_icons (id, attendance_id, item_name, fingerprint) VALUES (${crypto.randomUUID()}, ${attendanceId}, ${i.name}, ${icon})`;
        } else if (i.candidates?.length) {
          await sql`INSERT INTO attendance_ocr_icons (id, attendance_id, candidates, guess, fingerprint) VALUES (${crypto.randomUUID()}, ${attendanceId}, ${JSON.stringify(i.candidates)}, ${i.matched ? i.name : null}, ${icon})`;
        }
      }
    }
  } catch (err) {
    console.error('loot icon trainer could not record its icons:', err);
  }
}

// After a loot save: remembers which cut-off text each item came from (only
// when it was actually completed, not read whole). Best-effort.
async function recordLootTraining(attendanceId, items) {
  try {
    for (const i of items || []) {
      if (!i.matched || lootKey(i.fragment).length < 4 || lootKey(i.fragment) === lootKey(i.name)) continue;
      await sql`INSERT INTO attendance_ocr_loot (id, attendance_id, item_name, fragment_key) VALUES (${crypto.randomUUID()}, ${attendanceId}, ${i.name}, ${lootKey(i.fragment)})`;
    }
  } catch (err) {
    console.error('loot trainer could not record its matches:', err);
  }
}

// Thrown by scanAttendanceScreenshots; `key` names the member-facing text
// in lib/attendanceText.js, `cause` keeps the technical reason for the logs.
class AttendanceScanError extends Error {
  constructor(key, cause) {
    super(`${key}: ${cause?.message || cause}`);
    this.key = key;
  }
}


async function downloadScreenshots(imageUrls) {
  try {
    return await Promise.all(
      imageUrls.map(async (url, i) => {
        const res = await fetchWithRetry(url);
        if (!res.ok) throw new Error(`failed to download screenshot ${i + 1} (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
      })
    );
  } catch (err) {
    console.error('attendance download failed:', err);
    throw new AttendanceScanError('downloadFailed', err);
  }
}

// Downloads the screenshots, reads the blue/green/light-green nameplates
// off them and matches the names to the Growth Rate list. Used by the
// automatic scan of members' own screenshot posts.
async function scanAttendanceScreenshots(imageUrls) {
  const lists = [];
  for (const buffer of await downloadScreenshots(imageUrls)) lists.push(await readNamesFromScreenshot(buffer));
  return scanNameScreenshots(lists);
}

// The member who ran /attendance, as a Growth Rate name: their own
// character usually isn't readable in their own screenshot, but they were
// there. Tries the part of their Discord name after a "|" guild tag ("CAP |
// 자본丶Suszane" -> 자본丶Suszane), then the whole name, server nickname
// first. Only an exact match on the list counts -- never a guess.
// Add the person who ran /attendance to the attendees? Off for now (the
// user's call): the list is only what the screenshots show.
const ADD_SUBMITTER = false;
function findSubmitterOnList(discordNames, roster) {
  for (const raw of discordNames.filter(Boolean)) {
    for (const candidate of [String(raw).split('|').pop(), raw]) {
      const text = String(candidate).replace(/^@/, '').trim();
      if (!text) continue;
      const [hit] = matchToRoster([{ name: text, alternatives: [], color: 'self', uncertain: false }], roster);
      if (hit && hit.status === 'exact') return hit.name;
    }
  }
  return null;
}

// Matches the nameplates read off the battle screenshots (one list per
// screenshot, from readNamesFromScreenshot; none is
// fine: then only the submitter is listed). `submitterNames` are the Discord
// names of whoever ran the command, added via findSubmitterOnList.
async function scanNameScreenshots(perScreenshot, submitterNames = []) {
  // Snap each reading onto the Growth Rate list's spelling. If that list
  // can't be loaded, still post the raw OCR names rather than nothing.
  const readings = mergeNameLists(perScreenshot);
  const roster = await loadGrowthRateNames().catch((err) => {
    console.error('/attendance could not load the Growth Rate names:', err);
    return null;
  });
  // What the trainer has learned so far; matching works without it too.
  const trainer = roster ? await loadMatchingContext().catch((err) => {
    console.error('/attendance could not load the trainer data:', err);
    return {};
  }) : {};
  // Each entry: the name plus its mark (⚠️ guess / ❓ not on the list).
  let entries, legend, names = [];
  if (roster) {
    // Every sighting from every screenshot, each with all its OCR readings.
    // Only real members are listed: a ❓ reading (nothing on the list fits)
    // is a scrap of a hidden or blurred nameplate or an effect, not an
    // attendee, so it's left out of the post entirely (and never saved).
    const self = findSubmitterOnList(submitterNames, roster);
    const selfReading = self ? [{ name: self, alternatives: [], color: 'self', uncertain: false }] : [];
    names = matchToRoster([...perScreenshot.flat(), ...selfReading], roster, trainer).filter((n) => n.status !== 'unknown');
    entries = names.map((n) => {
      if (n.status === 'unknown') return `${escapeMarkdown(n.name)} ❓`;
      if (!n.confident) return `${escapeMarkdown(n.name)} ⚠️ (read as ${escapeMarkdown(n.readAs)})`;
      return escapeMarkdown(n.name);
    });
    legend = [
      names.some((n) => n.status !== 'unknown' && !n.confident) && multi('guess'),
      names.some((n) => n.status === 'unknown') && multi('notOnList'),
    ];
  } else {
    entries = readings.map((n) => `${escapeMarkdown(n.name)}${n.uncertain ? ' ⚠️' : ''}`);
    legend = [readings.some((n) => n.uncertain) && multi('hardToRead')];
  }
  legend = legend.filter(Boolean);
  const fullList = entries.map((e) => `• ${e}`).join('\n') + (legend.length ? `\n\n${legend.join('\n')}` : '');
  const counts = perScreenshot.map((l) => l.length);
  const countText = counts.length === 1 ? `${counts[0]} from this screenshot` : `${counts.join(' + ')} from ${counts.length} screenshots`;
  // Names to save on the site: everyone matched to the Growth Rate list,
  // ⚠️ guesses included (they're real members); ❓ unknowns are left out,
  // since they're often misreads.
  const savable = names.map((n) => n.name);
  const hasUnknown = roster ? entries.some((e) => e.endsWith(' ❓')) : false;
  // matches: for the trainer -- which reading each saved member came from.
  return { entries, legend, fullList, countText, savable, hasUnknown, matches: names };
}

const SITE_URL = (process.env.SITE_URL || 'https://sovereign-nightcrows.vercel.app').replace(/\/+$/, '');

// Saves the scan as a World Boss / Balthazard record (or adds it onto the
// same kill's record) and returns the lines saying so, for the post and
// the thread. A save failure doesn't stop the list from being posted.
async function saveScanToSite(boss, when, scan, loggedBy) {
  if (!scan.savable.length) return scan.hasUnknown ? [multi('unknownNotSaved')] : [];
  const page = boss.schedule === 'balthazard' ? 'balthazard' : 'worldboss';
  try {
    const saved = await saveAttendanceRecord({ boss, wall: when.wall, names: scan.savable, loggedBy });
    return [
      saved.merged
        ? multi('savedMerged', { time: `<t:${wallToUnix(saved.wall)}:t>`, added: saved.added, total: saved.total })
        : multi('savedNew', { page: boss.label, count: saved.total }),
      ...(scan.hasUnknown ? [multi('unknownNotSaved')] : []),
      `🔗 <${SITE_URL}/#${page}>`,
    ];
  } catch (err) {
    console.error('attendance could not be saved to the site:', err);
    return [multi('saveFailed')];
  }
}

// Starts a thread on `messageId` and lists the attendees in it, numbered.
async function postAttendeeThread(channelId, messageId, threadName, title, when, { entries, legend }, extraLines = [], footer) {
  const thread = await startThreadOnMessage(channelId, messageId, threadName);
  const numbered = entries.map((e, i) => `${i + 1}. ${e}`);
  const lines = [`**${escapeMarkdown(title)}**`, `📅 <t:${when.unix}:F>`, '', ...numbered, ...(legend.length ? ['', ...legend] : []), ...(extraLines.length ? ['', ...extraLines] : []), ...(footer ? ['', `-# ${footer}`] : [])];
  for (const chunk of chunkLines(lines)) {
    await postChannelMessage(thread.id, { content: chunk, allowed_mentions: { parse: [] } });
  }
  return thread;
}

// Thread names can't show Discord's <t:...> time, so they carry the
// Philippines clock time as text: "World Boss - Kafka · 11/20 21:30 · 16 attended".
function attendanceThreadName(boss, when, count) {
  const [, mo, d, hm] = when.wall.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})$/);
  return `${bossTitle(boss)} · ${mo}/${d} ${hm} · ${count} attended`;
}

// /attendance's boss is a fixed dropdown, so this only catches a stale
// Discord client sending an old free-text value: lists the real bosses.
const unknownBossText = (typed) => multi('unknownBoss', { boss: escapeMarkdown(typed), list: SCANNABLE_BOSSES.map((b) => b.boss).join(', ') });

// Sorts and reads the screenshots: battle screenshots for nameplates,
// loot-list screenshots (lootOcr.js recognizes them by their "11.20.2026
// 00:55" kill-time rows) for loot. Names are read first: a screenshot with
// 2+ nameplates is a battle screenshot, and the loot-list check -- a
// whole-screen OCR that took 3-8 s on a busy battle screenshot -- is
// skipped. Overlapping loot screenshots of one scrolling list are merged so
// no row counts twice.
const BATTLE_MIN_NAMES = 2;
async function splitLootScreenshots(buffers, { deep = false } = {}) {
  const lootLists = [];
  const nameLists = [];
  for (const buffer of buffers) {
    let names = [];
    try {
      names = await readNamesFromScreenshot(buffer, { deep });
    } catch (err) {
      console.error('attendance name reading failed:', err);
      throw new AttendanceScanError('readFailed', err);
    }
    if (names.length >= BATTLE_MIN_NAMES) {
      nameLists.push(names);
      continue;
    }
    const rows = await readLootList(buffer).catch((err) => {
      console.error('loot list check failed, treating it as a battle screenshot:', err);
      return null;
    });
    if (rows) lootLists.push(rows);
    else nameLists.push(names);
  }
  return { lootRows: mergeLootScreenshots(lootLists), lootShots: lootLists.length, nameLists };
}

// Loot rows -> one group per kill, item names completed against the site's
// item list and totaled. Rows of one boss within LOOT_SAME_KILL_MINUTES of
// each other are one kill -- Ducas and Dergio drop at 11:00 and 11:01 --
// using the earliest time. A row whose item can't be placed and has fewer
// than 5 letters ("TS a") is a scrap of the row, not an item, and is dropped.
const LOOT_SAME_KILL_MINUTES = 30;
function buildLootGroups(rows, knownItems, learnedItems, icons) {
  const minutes = (wall) => Date.parse(wall + ':00Z') / 60000;
  const groups = [];
  for (const row of [...rows].sort((a, b) => a.wall.localeCompare(b.wall))) {
    let group = groups.find((g) => g.boss.boss === row.boss.boss && minutes(row.wall) - minutes(g.wall) <= LOOT_SAME_KILL_MINUTES);
    if (!group) groups.push((group = { boss: row.boss, wall: row.wall, items: new Map() }));
    const done = completeItemName(row.fragment, row.boss.boss, knownItems, learnedItems, { icon: row.icon, icons });
    if (!done.matched && (row.fragment.match(/[A-Za-z]/g) || []).length < 5) continue;
    const itemKey = done.matched ? done.name : `?${row.fragment.toLowerCase()}`;
    const item = group.items.get(itemKey) || { name: done.name, fragment: row.fragment, matched: done.matched, confident: done.confident, byText: done.byText, candidates: done.candidates, icons: [], quantity: 0 };
    item.quantity += row.quantity;
    item.confident = item.confident && done.confident;
    item.byText = item.byText && done.byText;
    if (row.icon) item.icons.push(row.icon);
    group.items.set(itemKey, item);
  }
  return groups.map((g) => ({ ...g, items: [...g.items.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)) }));
}

// Saves each kill's loot and returns, per kill, the line for the post and
// the item lines for the thread.
async function saveLootGroups(groups, loggedBy) {
  const out = [];
  for (const g of groups) {
    const saveable = g.items.filter((i) => i.matched).map((i) => ({ name: i.name, quantity: i.quantity }));
    const count = saveable.reduce((s, i) => s + i.quantity, 0);
    let postLine = null;
    let status = 'none'; // none | added | created | partial | skipped | failed
    let alreadyThere = 0;
    if (saveable.length) {
      try {
        const saved = await saveLootToRecord({ boss: g.boss, wall: g.wall, items: saveable, loggedBy });
        await recordLootTraining(saved.id, g.items);
        await recordIconTraining(saved.id, g.items);
        alreadyThere = saved.alreadyThere;
        const vars = { boss: g.boss.boss, time: `<t:${wallToUnix(saved.wall)}:f>`, count };
        status = saved.added === 0 ? 'skipped' : saved.created ? 'created' : alreadyThere ? 'partial' : 'added';
        postLine = multi(saved.added === 0 ? 'lootAlreadyThere' : saved.created ? 'lootNewRecord' : 'lootAdded', vars);
      } catch (err) {
        console.error('loot could not be saved to the site:', err);
        status = 'failed';
        postLine = multi('lootSaveFailed');
      }
    }
    const itemLines = g.items.map((i) => {
      if (!i.matched) return `• ${escapeMarkdown(i.fragment)} ×${i.quantity} ❓`;
      if (!i.confident) return `• ${escapeMarkdown(i.name)} ×${i.quantity} ⚠️ (read as ${escapeMarkdown(i.fragment)})`;
      return `• ${escapeMarkdown(i.name)} ×${i.quantity}`;
    });
    const legend = [g.items.some((i) => i.matched && !i.confident) && multi('lootGuess'), g.items.some((i) => !i.matched) && multi('lootUnknown')].filter(Boolean);
    out.push({ group: g, status, alreadyThere, postLine, threadLines: [`**🎁 ${escapeMarkdown(bossTitle(g.boss))} · <t:${wallToUnix(g.wall)}:f>**`, ...itemLines, ...(legend.length ? ['', ...legend] : [])] });
  }
  return out;
}

// Every Discord ID (message, attachment) encodes when it was created: the
// top bits are milliseconds since Discord's epoch (2015-01-01). For an
// attachment that's the moment it was uploaded.
const DISCORD_EPOCH_MS = 1420070400000n;
function snowflakeTime(id) {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
  } catch {
    return Date.now();
  }
}

// /attendance: read the screenshots attached to the command -- battle
// screenshots for who was there, loot-list screenshots for the drops --
// save both on the site, and post one record: Boss, Time of Death,
// Attendees List, Loots, with the screenshots.
// `rescanMessage`: set when the post's 🔄 Rescan button was pressed -- then
// the screenshots, boss and replace-on-save come from that post itself, and
// the scan is a deep one (every nameplate gets every setting), since the
// same quick scan of the same images would just give the same answer.
async function processAttendance({ applicationId, token, options = [], resolved, member, user, rescanMessage }) {
  const getOpt = (name) => options.find((o) => o.name === name)?.value;
  const bossText = rescanMessage
    ? String(rescanMessage.embeds?.[0]?.fields?.find((f) => f.name === 'Boss')?.value || '').trim()
    : String(getOpt('boss') || '').trim();
  const runnerName = member?.nick || member?.user?.global_name || member?.user?.username || user?.global_name || user?.username;
  // On a rescan the attendee added for "who ran it" is still the original
  // poster (from the footer's "logged by"), not whoever pressed the button.
  const loggedByBefore = rescanMessage ? String(rescanMessage.embeds?.[0]?.footer?.text || '').match(/logged by (.+?)(?: · |$)/)?.[1] : null;
  const submitterName = loggedByBefore || runnerName;
  const attachments = rescanMessage
    ? postScreenshots(rescanMessage)
    : ATTENDANCE_SCREENSHOT_OPTIONS.map((name) => resolved?.attachments?.[getOpt(name)]).filter(Boolean);

  // ✅ on the bot's post once everything is read, saved and threaded; ❌ when
  // it stopped with an error -- so the channel shows at a glance which
  // uploads went through.
  const markDone = (msg, emoji) => msg && addReaction(msg.channel_id, msg.id, emoji);
  const failWith = async (description) => {
    if (!rescanMessage) return markDone(await editOriginalResponse(applicationId, token, { embeds: [{ color: 0xe74c3c, description }] }), '❌');
    // A failed rescan leaves the post as it was: tell only the presser, and
    // put the button back.
    await postFollowup(applicationId, token, { flags: 64, embeds: [{ color: 0xe74c3c, description }] });
    await editOriginalResponse(applicationId, token, { components: rescanComponents() });
  };

  // /api/discord-interactions skips the site's schema middleware; make sure
  // every table exists (cached per instance), incl. the trainer's.
  await ensureSchema().catch((err) => console.error('/attendance could not prepare the database:', err));
  const boss = findBossInText(bossText);
  if (!boss) return void (await failWith(unknownBossText(bossText)));
  if (!attachments.length || attachments.some((a) => !(a.content_type || '').startsWith('image/'))) {
    return void (await failWith(multi('invalidAttachment')));
  }
  let buffers;
  try {
    buffers = await downloadScreenshots(attachments.map((a) => a.url));
  } catch (err) {
    if (!(err instanceof AttendanceScanError)) throw err;
    return void (await failWith(multi(err.key)));
  }
  let split;
  try {
    split = await splitLootScreenshots(buffers, { deep: Boolean(rescanMessage) });
  } catch (err) {
    if (!(err instanceof AttendanceScanError)) throw err;
    return void (await failWith(multi(err.key)));
  }
  const { lootRows, lootShots, nameLists } = split;
  const lootGroups = lootRows.length
    ? buildLootGroups(lootRows, await loadKnownItems().catch(() => []), await loadLearnedItems().catch(() => new Map()), await loadIconLibrary().catch((err) => (console.error("loot icons could not be loaded:", err), new Map())))
    : [];
  // The Time of Death comes only from the loot list ("11.20.2026 00:55"), so
  // the loot screenshot is required, and it has to be the picked boss's --
  // otherwise names would be filed under the wrong kill. Nothing is saved
  // in either case.
  if (!lootGroups.length) return void (await failWith(multi('needLootList')));
  const sameKill = lootGroups.find((g) => g.boss.boss === boss.boss);
  if (!sameKill) {
    const lootBoss = [...new Set(lootGroups.map((g) => g.boss.boss))].join(', ');
    return void (await failWith(multi('lootBossMismatch', { boss: escapeMarkdown(boss.boss), lootBoss: escapeMarkdown(lootBoss) })));
  }
  const when = { wall: sameKill.wall, unix: wallToUnix(sameKill.wall) };

  // Battle screenshots for who was there. Whoever ran the command is only
  // added when ADD_SUBMITTER is on (off for now: only names read off the
  // screenshots count).
  const submitterNames = !ADD_SUBMITTER ? [] : loggedByBefore ? [loggedByBefore] : [member?.nick, member?.user?.global_name, member?.user?.username, user?.global_name, user?.username];
  let scan = null;
  try {
    scan = await scanNameScreenshots(nameLists, submitterNames);
  } catch (err) {
    if (!(err instanceof AttendanceScanError)) throw err;
    if (!lootGroups.length) return void (await failWith(multi(err.key)));
  }
  const entries = scan?.entries || [];
  if (!entries.length && !lootGroups.length) return void (await failWith(multi('noNames')));

  // Save: attendees (sure + ⚠️ guesses, not ❓) and each kill's loot.
  // Normally this adds to the kill's record (a second screenshot of the
  // same fight). With rescan:True it replaces what was saved for this kill
  // instead -- the way to correct a wrong scan.
  const notes = [];
  const rescan = Boolean(rescanMessage) || getOpt('rescan') === true;
  let loot;
  if (rescan) {
    const items = sameKill.items.filter((i) => i.matched).map((i) => ({ name: i.name, quantity: i.quantity }));
    try {
      const r = await replaceAttendanceRecord({ boss, wall: when.wall, names: scan?.savable || [], items, loggedBy: runnerName });
      if (scan?.savable.length) await recordTraining(r.id, scan.matches);
      await recordIconTraining(r.id, sameKill.items);
      if (!r.created) notes.push(`Rescan: replaced the saved ${[scan?.savable.length && 'names', r.lootReplaced && 'loot'].filter(Boolean).join(' and ') || 'record'}`);
      if (r.lootKept) notes.push('Loot kept: it already has prices/sales on the site, fix it there');
    } catch (err) {
      console.error('attendance rescan could not be saved to the site:', err);
      notes.push('⚠️ Rescan not saved to the website');
    }
    // Loot rows for other kills on the same list are saved the normal way.
    const others = await saveLootGroups(lootGroups.filter((g) => g !== sameKill), submitterName);
    loot = [{ group: sameKill, status: 'replaced' }, ...others];
  } else {
    if (scan?.savable.length) {
      try {
        const saved = await saveAttendanceRecord({ boss, wall: when.wall, names: scan.savable, loggedBy: submitterName });
        await recordTraining(saved.id, scan.matches);
      } catch (err) {
        console.error('attendance could not be saved to the site:', err);
        notes.push('⚠️ Attendees not saved to the website');
      }
    }
    loot = await saveLootGroups(lootGroups, submitterName);
  }
  if (loot.some((l) => l.status === 'skipped')) notes.push('Loot was already on the site, not added again (use rescan:True to replace it)');
  const partly = loot.reduce((s, l) => s + (l.status === 'partial' ? l.alreadyThere : 0), 0);
  if (partly) notes.push(`${partly} loot item${partly === 1 ? ' was' : 's were'} already on the site; the rest were added`);
  if (loot.some((l) => l.status === 'failed')) notes.push('⚠️ Loot not saved to the website');

  // One clean post: Boss, Time of Death, Attendees List, Loots, and the
  // screenshots themselves. Names and items are shown plainly -- a guessed
  // name (the closest Growth Rate name to a blurry reading) is listed and
  // saved like any other, without a ⚠️. Only loot items not on the site's
  // list keep a ❓, since those are not saved.
  const anyUnknown = loot.some((l) => l.group.items.some((i) => !i.matched));
  const shotCount = `${buffers.length} screenshot${buffers.length === 1 ? "" : "s"} read${lootShots ? ` (${lootShots} loot list${lootShots === 1 ? "" : "s"})` : ""}`;
  const footer = [
    ...notes,
    anyUnknown && "❓ = not sure which item (or not on the site's item list), not saved",
    shotCount,
    `logged by ${submitterName}`,
    rescanMessage && `rescanned by ${runnerName}`,
  ].filter(Boolean).join(" · ");

  const attendeeLines = entries.map((e, i) => `${i + 1}. ${e.replace(/ ⚠️.*$/, '')}`);
  const lootLines = loot.flatMap((l) => [
    ...(loot.length > 1 || l.group.boss.boss !== boss.boss ? [`**${escapeMarkdown(l.group.boss.boss)} · <t:${wallToUnix(l.group.wall)}:t>**`] : []),
    ...l.group.items.map((i) => `${escapeMarkdown(i.matched ? i.name : i.fragment)} ×${i.quantity}${!i.matched ? ' ❓' : ''}${!i.matched && i.candidates?.length ? ` (${escapeMarkdown(i.candidates.join(' / '))}?)` : ''}`),
  ]);
  const lootTotal = loot.reduce((s, l) => s + l.group.items.reduce((t, i) => t + i.quantity, 0), 0);

  const page = boss.schedule === 'balthazard' ? 'balthazard' : 'worldboss';
  const embed = {
    color: 0xe74c3c,
    url: `${SITE_URL}/#${page}`, // also groups the screenshots below into one gallery
    fields: [
      { name: 'Boss', value: escapeMarkdown(boss.boss), inline: true },
      { name: 'Time of Death', value: `<t:${when.unix}:F>`, inline: true },
      ...listFields(`Attendees List (${entries.length})`, attendeeLines),
      ...listFields(`Loots (${lootTotal})`, lootLines),
    ].slice(0, 25),
    footer: { text: footer.slice(0, 2048) },
  };

  const saveWarning = notes.some((n) => n.startsWith('⚠️'));

  // Rescan: the screenshots are already on the post -- keep them (by id) and
  // only swap the text, then put the 🔄 button back.
  if (rescanMessage) {
    const kept = attachments.map((a) => ({ id: a.id }));
    let posted = await editOriginalResponse(applicationId, token, {
      embeds: screenshotEmbeds(embed, attachments.map((a) => a.filename)),
      attachments: kept,
      components: rescanComponents(),
    });
    if (!posted) posted = await editOriginalResponse(applicationId, token, { embeds: [embed], attachments: kept, components: rescanComponents() });
    if (saveWarning) await markDone(posted, '⚠️');
    return;
  }

  // The screenshots themselves, re-uploaded with the post (the links Discord
  // gives for command attachments expire).
  const files = await screenshotsForPost(buffers);
  let posted = await editOriginalResponseWithFiles(applicationId, token, { embeds: screenshotEmbeds(embed, files.map((f) => f.filename)), components: rescanComponents() }, files);
  // Too big to upload, or Discord refused the files: still post the record.
  if (!posted) posted = await editOriginalResponse(applicationId, token, { embeds: [embed] });
  await markDone(posted, saveWarning ? '⚠️' : '✅');
}

// The screenshots on an attendance post, in order, for the Rescan button.
// Discord leaves `attachments` empty for files shown inside the embeds, so
// they're taken from the embed images: cdn.discordapp.com/attachments/
// <channel>/<attachment id>/<filename>?<signature> (freshly signed in the
// button's interaction, so downloadable).
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
function postScreenshots(message) {
  const byName = new Map();
  for (const a of message.attachments || []) {
    if ((a.content_type || '').startsWith('image/') || IMAGE_FILE.test(a.filename || '')) byName.set(a.filename, { ...a, content_type: a.content_type || 'image/jpeg' });
  }
  for (const e of message.embeds || []) {
    const url = e.image?.url;
    const m = url && new URL(url).pathname.match(/\/attachments\/\d+\/(\d+)\/([^/]+)$/);
    if (m && !byName.has(m[2]) && IMAGE_FILE.test(m[2])) byName.set(m[2], { id: m[1], filename: m[2], url, content_type: 'image/jpeg' });
  }
  const order = (a) => Number(a.filename.match(/\d+/)?.[0]) || 0;
  return [...byName.values()].sort((a, b) => order(a) - order(b));
}

// Every screenshot shown on the post, up to 10 (Discord's embed limit).
// Discord merges embeds sharing one url into a gallery of at most 4 images,
// so each group of 4 gets its own url (same page, a ?shots=N marker) --
// 10 screenshots show as galleries of 4 + 4 + 2. The first embed carries
// the record itself.
function screenshotEmbeds(embed, filenames) {
  if (!filenames.length) return [embed];
  return filenames.slice(0, 10).map((filename, i) => {
    const group = Math.floor(i / 4);
    const url = group ? embed.url.replace('/#', `/?shots=${group + 1}#`) : embed.url;
    const image = { url: `attachment://${filename}` };
    return i === 0 ? { ...embed, image } : { url, image };
  });
}

// The 🔄 Rescan button under every attendance post: reads the post's own
// screenshots again (deep scan) and replaces the saved record -- no
// re-uploading. While it runs the button is disabled so it can't be
// pressed twice.
const RESCAN_BUTTON_ID = 'attendance:rescan';
function rescanComponents(running = false) {
  return [{
    type: 1,
    components: [{ type: 2, style: 2, custom_id: RESCAN_BUTTON_ID, emoji: { name: '🔄' }, label: running ? 'Rescanning…' : 'Rescan', disabled: running }],
  }];
}

// Follow-up message on an interaction (flags: 64 = only the presser sees it).
async function postFollowup(applicationId, token, payload) {
  const res = await fetchWithRetry(`https://discord.com/api/v10/webhooks/${applicationId}/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error('postFollowup failed:', res.status, await res.text().catch(() => ''));
}

// A list as embed fields: Discord caps a field at 1024 characters, so a
// long list continues in further fields under the same heading.
function listFields(title, lines) {
  if (!lines.length) return [{ name: title, value: '—' }];
  const fields = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > 1000) {
      fields.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  fields.push(current);
  return fields.map((value, i) => ({ name: i ? `${title} (cont.)` : title, value }));
}

// The screenshots for the post. The 🔄 Rescan button reads these copies
// later, so they're kept as close to the uploads as Discord's upload limit
// (10 MB per message) allows: the files exactly as uploaded when they all
// fit, otherwise the lightest re-compression that fits -- a blurrier copy
// loses faint names (Bяielle) on a rescan.
const POST_UPLOAD_BUDGET = 9.5 * 1024 * 1024;
const POST_JPEG_STEPS = [
  { quality: 95, width: 2560 },
  { quality: 90, width: 2560 },
  { quality: 85, width: 1920 },
  { quality: 75, width: 1600 },
];
async function screenshotsForPost(buffers) {
  const asUploaded = await Promise.all(buffers.map(async (buffer, i) => {
    const format = await sharp(buffer).metadata().then((m) => m.format).catch(() => null);
    const ext = format === 'jpeg' ? 'jpg' : format === 'webp' ? 'webp' : 'png';
    return { buffer, contentType: `image/${format === 'jpeg' ? 'jpeg' : ext}`, filename: `screenshot${i + 1}.${ext}` };
  }));
  const total = (files) => files.reduce((s, f) => s + f.buffer.length, 0);
  if (total(asUploaded) <= POST_UPLOAD_BUDGET) return asUploaded;
  let files;
  for (const step of POST_JPEG_STEPS) {
    files = await Promise.all(buffers.map(async (buffer, i) => ({
      buffer: await sharp(buffer).rotate().resize({ width: step.width, height: step.width, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: step.quality }).toBuffer(),
      contentType: 'image/jpeg',
      filename: `screenshot${i + 1}.jpg`,
    })));
    if (total(files) <= POST_UPLOAD_BUDGET) break;
  }
  return files;
}

// Edits the deferred /attendance reply with files attached, referenced from
// the embeds as attachment://<filename>. Returns the message, or null.
async function editOriginalResponseWithFiles(applicationId, token, payload, files) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.filename })) }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.buffer], { type: f.contentType }), f.filename));
  const res = await fetchWithRetry(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, { method: 'PATCH', body: form });
  if (!res.ok) {
    console.error('editOriginalResponseWithFiles failed:', res.status, await res.text().catch(() => ''));
    return null;
  }
  return res.json().catch(() => null);
}

// Automatic scan: a member posted screenshots in the attendance channel with
// a boss name in the message ("Kafka", "ducas 88/96"). Forwarded here by
// the always-on gateway bot (discord-bot/index.js), since only a gateway
// connection hears new messages. The thread goes on the member's own post,
// so the screenshots are never re-posted. 🔍 while reading, then ✅ / ❌.
// Returns why it skipped a message, or null once handled.
async function processAttendanceMessage({ channelId, messageId, content, imageUrls, authorName }) {
  if (!isAttendanceChannel(channelId)) return 'not an attendance channel';
  if (!imageUrls?.length) return 'no screenshots';
  const boss = findBossInText(content);
  if (!boss) return 'no boss name in the message';

  await addReaction(channelId, messageId, '🔍');
  const done = async (emoji) => {
    await removeOwnReaction(channelId, messageId, '🔍');
    await addReaction(channelId, messageId, emoji);
  };
  const reply = (text) =>
    postChannelMessage(channelId, { content: text, message_reference: { message_id: messageId, fail_if_not_exists: false }, allowed_mentions: { parse: [] } }).catch((err) =>
      console.error('attendance scan could not reply:', err)
    );

  let scan;
  try {
    scan = await scanAttendanceScreenshots(imageUrls);
  } catch (err) {
    console.error('attendance scan failed:', err);
    await done('❌');
    await reply(multi(err instanceof AttendanceScanError ? err.key : 'readFailed'));
    return null;
  }
  if (!scan.entries.length) {
    await done('❌');
    await reply(multi('noNames'));
    return null;
  }

  const when = resolveEventTime(new Date(snowflakeTime(messageId))); // when the post was made
  const title = `${bossTitle(boss)} · ${scan.entries.length} attended`;
  const savedLines = await saveScanToSite(boss, when, scan, authorName);
  try {
    await postAttendeeThread(channelId, messageId, attendanceThreadName(boss, when, scan.entries.length), title, when, scan, savedLines, `${scan.countText} · posted by ${authorName}`);
    await done('✅');
  } catch (err) {
    // No thread possible: reply with the list instead so it isn't lost.
    console.error('attendance scan could not post the thread:', err);
    for (const chunk of chunkLines([`**${escapeMarkdown(title)}**`, `📅 <t:${when.unix}:F>`, ...scan.fullList.split('\n'), ...savedLines])) await reply(chunk);
    await done('✅');
  }
  return null;
}

// Best-effort, like addReaction: removes the bot's own reaction.
async function removeOwnReaction(channelId, messageId, emoji) {
  if (!DISCORD_TOKEN) return;
  try {
    const res = await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    });
    if (!res.ok && res.status !== 404) console.error('removeOwnReaction failed:', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('removeOwnReaction threw:', err);
  }
}

// Names are shown as-is, so characters Discord treats as formatting
// (BAzoo_KA, *star*, ~x~) are escaped instead of turning into italics etc.
function escapeMarkdown(text) {
  return String(text).replace(/([\\*_~`|>])/g, '\\$1');
}

// Splits lines into messages under Discord's 2000-character limit.
function chunkLines(lines, max = 1900) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > max) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

// Starts a public thread on an existing message (the bot's attendance post).
// Needs the bot to have Create Public Threads + Send Messages in Threads in
// the channel. Archives after a day of no activity, like a normal thread.
async function startThreadOnMessage(channelId, messageId, name) {
  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set -- cannot start a thread.');
  const res = await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_TOKEN}` },
    body: JSON.stringify({ name: name.slice(0, 100), auto_archive_duration: 1440 }),
  });
  if (!res.ok) throw new Error(`Discord refused to start the thread (${res.status}): ${await res.text().catch(() => '')}`);
  return res.json();
}

// The actual /uniongr work, run *after* Discord already has our deferred
// ack -- errors here are reported by editing that deferred response, not by
// throwing back to the HTTP handler (the response has already been sent).
async function processUniongrSubmission({ applicationId, token, interactionId, channelId, siteBaseUrl, options, resolved, member, user }) {
  // /uniongr same-ign or /uniongr switched-ign -- the fields sit inside the
  // chosen sub-command.
  const sub = options[0]?.type === 1 /* SUB_COMMAND */ ? options[0] : null;
  const fields = sub ? sub.options || [] : options;
  const getOpt = (name) => fields.find((o) => o.name === name)?.value;
  const ign = String(getOpt('ign') || '').trim();
  let className = String(getOpt('class') || '').trim();
  let guildName = getOpt('guild');
  let lampLevel = Number(getOpt('lamp'));
  const growthRate = Number(getOpt('growthrate'));
  const attachmentId = getOpt('screenshot');
  const changedIgn = sub?.name === 'switched-ign' || sub?.name === 'changed-ign'; // changed-ign: the old name, until clients refresh
  const oldIgn = String(getOpt('oldign') || '').trim();
  const attachment = resolved?.attachments?.[attachmentId];

  // Server nickname first (what members actually recognize each other by),
  // falling back to the account's global display name, then its username --
  // computed up front so rejection logging below can use it too.
  const submitterName = member?.nick || member?.user?.global_name || member?.user?.username || user?.global_name || user?.username;
  const discordUserId = member?.user?.id || user?.id;

  async function reject(reason, embedOrContent) {
    await logBotActivity({ action: 'reject', description: `Rejected a /uniongr submission from ${submitterName}: ${reason}`, submitterName, after: { ign, className, guildName, lampLevel, growthRate } });
    await editOriginalResponse(applicationId, token, embedOrContent);
  }

  if (changedIgn && !oldIgn) {
    await reject('changed IGN without an old IGN', {
      embeds: [rejectionEmbed('❌ Old IGN missing', 'You said you changed your IGN, but did not fill in **oldign**.', 'Run `/uniongr switched-ign` again and pick your **old** IGN in the `oldign` field (start typing it to see suggestions).')],
    });
    return;
  }
  // same-ign leaves class/guild/lamp optional: whatever's left empty is
  // copied from that IGN's current Growth Rate entry, so a returning member
  // only has to send their new GR + screenshot.
  if (!changedIgn && (!className || !guildName || getOpt('lamp') === undefined)) {
    const { rows } = await sql`
      SELECT class, guild_name, lamp_level FROM growth_submissions
      WHERE LOWER(TRIM(ign)) = LOWER(${ign}) ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `.catch(() => ({ rows: [] }));
    const current = rows[0];
    if (!current) {
      await reject('first submission missing class/guild/lamp', {
        embeds: [
          rejectionEmbed(
            '❌ First time? Fill in everything',
            `There's no Growth Rate entry for **${ign}** yet, so **class**, **guild** and **lamp** can't be copied from it.`,
            'Run `/uniongr same-ign` again and fill in **class**, **guild** and **lamp** too. If you already have an entry, pick your IGN from the suggestions so it matches exactly.'
          ),
        ],
      });
      return;
    }
    if (!className) className = current.class || '';
    if (!guildName) guildName = current.guild_name;
    if (getOpt('lamp') === undefined) lampLevel = Number(current.lamp_level);
  }
  if (!attachment || !(attachment.content_type || '').startsWith('image/')) {
    await reject('invalid attachment', { embeds: [rejectionEmbed('❌ Invalid attachment', 'The screenshot attachment has to be an image.')] });
    return;
  }
  // Same cropped-popup-vs-full-screen check as the old bot -- Discord already
  // reports image dimensions on the attachment, no download needed for this.
  if (attachment.width && attachment.height && attachment.width <= attachment.height) {
    await reject('cropped screenshot', {
      embeds: [
        rejectionEmbed(
          '❌ Screenshot rejected',
          'That looks like a cropped screenshot of just the stats popup, not a full screen capture.',
          '• A **full landscape screenshot** (wider than it is tall), not a cropped portrait image.\n' +
            '• Your **character visible on screen** next to the Character Details/Artifacts panel, not just the popup by itself.\n\n' +
            "Take a normal screen capture (don't crop it down) and run `/uniongr` again."
        ),
      ],
    });
    return;
  }
  if (!VALID_GUILDS.includes(guildName)) {
    await reject('invalid guild', { content: `Guild must be one of: ${VALID_GUILDS.join(', ')}` });
    return;
  }
  if (!VALID_CLASSES.includes(className)) {
    await reject('invalid class', { content: `Class must be one of: ${VALID_CLASSES.join(', ')}` });
    return;
  }
  if (!isValidLampLevel(lampLevel)) {
    await reject('invalid Volcano Lamp level', { content: `Volcano Lamp level must be an integer between ${LAMP_MIN} and ${LAMP_MAX}.` });
    return;
  }
  if (!Number.isInteger(growthRate) || growthRate < 0) {
    await reject('invalid Growth Rate', { content: 'Growth Rate must be a non-negative integer.' });
    return;
  }

  try {
    const imageResponse = await fetchWithRetry(attachment.url);
    if (!imageResponse.ok) throw new Error(`failed to download the attachment (${imageResponse.status})`);
    const arrayBuffer = await imageResponse.arrayBuffer();
    const { buffer, contentType: imageContentType } = await compressImageIfNeeded(Buffer.from(arrayBuffer), attachment.content_type || 'image/png');

    const saveRes = await fetchWithRetry(`${siteBaseUrl}/api/growth-submissions/bot${changedIgn ? '/ign-change' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': GROWTH_BOT_SECRET },
      body: JSON.stringify({
        ...(changedIgn ? { oldIgn, channelId } : {}),
        discordMessageId: interactionId, // no confirmation message to key off of anymore -- the interaction id is unique enough
        discordUserId,
        discordUsername: submitterName,
        ign,
        class: className,
        guildName,
        lampLevel,
        growthRate,
        imageBase64: buffer.toString('base64'),
        imageContentType,
      }),
    });
    if (!saveRes.ok) {
      if (saveRes.status === 413) throw new Error('the screenshot is too large even after compression -- try a smaller/cropped screenshot');
      const body = await saveRes.json().catch(() => ({}));
      throw new Error(body.error || `the app returned ${saveRes.status}`);
    }
    const saved = await saveRes.json().catch(() => ({}));

    // An IGN change isn't applied until an admin checks it on the Growth
    // Rate page -- tell the submitter it's waiting, and flag it for admins.
    if (changedIgn) {
      await editOriginalResponse(applicationId, token, { content: `⏳ Sent for admin approval — **${saved.oldIgn || oldIgn}** → **${ign}**. You'll see a message here once it's approved.` });
      await postChannelMessage(channelId, {
        embeds: [{ color: 0xf1c40f, title: `IGN change request — ${saved.oldIgn || oldIgn} → ${ign}`, description: 'Waiting for an admin to approve it on the Growth Rate page.' }],
      }).catch((err) => console.error('Failed to post the IGN change notice:', err));
      await restickGrowthGuide(channelId);
      const dmEmbed = {
        color: 0xf1c40f,
        title: `IGN change to verify — ${saved.oldIgn || oldIgn} → ${ign}`,
        url: `${siteBaseUrl}/#growth`,
        description: `Sent by **${submitterName}**. Approve or reject it under **IGN change requests** on the Growth Rate page.`,
        fields: [
          { name: 'Class', value: className, inline: true },
          { name: 'Guild', value: guildName, inline: true },
          { name: 'Lamp', value: `+${lampLevel}`, inline: true },
          { name: 'Growth Rate', value: growthRate.toLocaleString(), inline: true },
        ],
        ...(saved.id ? { image: { url: `${siteBaseUrl}/api/ign-change-requests/${saved.id}/image` } } : {}),
      };
      for (const userId of IGN_CHANGE_DM_USER_IDS) {
        await sendDirectMessage(userId, { embeds: [dmEmbed] }).catch((err) => console.error('Failed to DM about the IGN change:', err));
      }
      return;
    }

    // The submitter's own confirmation stays fully private (edited reply +
    // a ✅ reaction on it) -- separately, a short admin-facing notice is
    // posted to the channel itself (not a DM) so admins see at a glance that
    // someone submitted and how the running total moved.
    const confirmMessage = await editOriginalResponse(applicationId, token, { content: '✅ Saved — check the Growth Rate page.' });
    if (confirmMessage?.id) await addReaction(channelId, confirmMessage.id, '✅');

    if (typeof saved.totalSubmissions === 'number') {
      const embed = {
        color: 0x2ecc71,
        title: `Added — ${ign}`,
        description: '✅ Saved — check the Growth Rate page.',
        fields: buildRankedIgnFields(saved.rankedIgns || []),
        footer: { text: `Total submissions: ${saved.totalSubmissions}` },
      };
      await postChannelMessage(channelId, { embeds: [embed] }).catch((err) => console.error('Failed to post the admin notice:', err));
      await restickGrowthGuide(channelId);
    }
  } catch (err) {
    console.error('Failed to submit a growth entry via /uniongr:', err);
    await logBotActivity({
      action: 'error',
      description: `/uniongr submission from ${submitterName} for "${ign}" failed: ${err.message}`,
      submitterName,
      after: { ign, className, guildName, lampLevel, growthRate },
    });
    await editOriginalResponse(applicationId, token, { content: `Something went wrong saving this: ${err.message}` }).catch(() => {});
  }
}

// Every name a member could be listed under somewhere -- Growth Rate,
// attendance or a crusade roster -- one per spelling (case-insensitive).
// Feeds /uniongr's oldign autocomplete.
async function findKnownMemberNames(search, limit) {
  const { rows } = await sql`
    SELECT DISTINCT ON (LOWER(TRIM(name))) TRIM(name) AS name
    FROM (
      SELECT ign AS name FROM growth_submissions
      UNION ALL SELECT member_name FROM world_boss_attendees
      UNION ALL SELECT name FROM crusade_participants
    ) n
    WHERE TRIM(name) <> '' AND POSITION(LOWER(${search}) IN LOWER(name)) > 0
    ORDER BY LOWER(TRIM(name))
    LIMIT ${limit}
  `;
  return rows.map((r) => r.name);
}

// Express route handler for POST /api/discord-interactions. Needs req.rawBody
// (the raw bytes, captured by express.json()'s `verify` option in app.js) --
// Ed25519 signature verification fails on re-serialized JSON, which can
// differ byte-for-byte from what Discord actually sent and signed.
async function handleDiscordInteraction(req, res) {
  if (!DISCORD_PUBLIC_KEY) {
    console.error('DISCORD_PUBLIC_KEY is not set -- cannot verify Discord interaction requests.');
    return res.status(500).end();
  }
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const isValid = signature && timestamp && req.rawBody && (await verifyKey(req.rawBody, signature, timestamp, DISCORD_PUBLIC_KEY));
  if (!isValid) return res.status(401).end();

  const interaction = req.body;

  if (interaction.type === 1 /* PING */) {
    return res.json({ type: 1 /* PONG */ });
  }

  if (interaction.type === 2 /* APPLICATION_COMMAND */ && interaction.data?.name === 'uniongr') {
    // Ack within Discord's 3-second window; the real work happens after this
    // response is sent, using the interaction's follow-up webhook.
    res.json({ type: 5 /* DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE */, data: { flags: 64 /* ephemeral */ } });
    const siteBaseUrl = `https://${req.headers.host}`;
    // waitUntil() is what actually keeps this work running after the
    // response above has already been sent -- without it, Vercel doesn't
    // guarantee the function instance stays alive for a "fire and forget"
    // promise, which is exactly why this was silently never finishing
    // (stuck on "thinking..." forever) before this was added.
    waitUntil(
      processUniongrSubmission({
        applicationId: interaction.application_id,
        token: interaction.token,
        interactionId: interaction.id,
        channelId: interaction.channel_id || interaction.channel?.id,
        siteBaseUrl,
        options: interaction.data.options || [],
        resolved: interaction.data.resolved,
        member: interaction.member,
        user: interaction.user,
      }).catch((err) => console.error('Unhandled error processing /uniongr interaction:', err))
    );
    return;
  }

  if (interaction.type === 2 /* APPLICATION_COMMAND */ && interaction.data?.name === 'attendance') {
    const channelId = String(interaction.channel_id || interaction.channel?.id || '');
    if (!isAttendanceChannel(channelId)) {
      return res.json({ type: 4 /* CHANNEL_MESSAGE_WITH_SOURCE */, data: { flags: 64, content: forLocale('wrongChannel', interaction.locale, { channel: ATTENDANCE_CHANNEL_IDS.map((id) => `<#${id}>`).join(' / ') }) } });
    }
    // Public (not ephemeral) deferral: the name list is meant for the whole
    // channel, like the "World Boss - ..." posts. Reading takes a while, so
    // the work continues under waitUntil after this ack.
    res.json({ type: 5 /* DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE */ });
    waitUntil(
      processAttendance({
        applicationId: interaction.application_id,
        token: interaction.token,
        options: interaction.data.options || [],
        resolved: interaction.data.resolved,
        member: interaction.member,
        user: interaction.user,
      }).catch(async (err) => {
        console.error('Unhandled error processing /attendance interaction:', err);
        await editOriginalResponse(interaction.application_id, interaction.token, { content: 'Something went wrong reading that screenshot. Please try again.' }).catch(() => {});
      })
    );
    return;
  }

  // 🔄 Rescan pressed on an attendance post. Answer at once by disabling the
  // button ("Rescanning…"), then read the post's screenshots again.
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && interaction.data?.custom_id === RESCAN_BUTTON_ID) {
    const message = interaction.message;
    const busy = message?.components?.[0]?.components?.[0]?.disabled;
    if (busy) return res.json({ type: 4, data: { flags: 64, content: 'Already rescanning this one -- give it a minute.' } });
    res.json({ type: 7 /* UPDATE_MESSAGE */, data: { components: rescanComponents(true) } });
    waitUntil(
      processAttendance({
        applicationId: interaction.application_id,
        token: interaction.token,
        member: interaction.member,
        user: interaction.user,
        rescanMessage: message,
      }).catch(async (err) => {
        console.error('Unhandled error processing attendance rescan:', err);
        await postFollowup(interaction.application_id, interaction.token, { flags: 64, content: 'Something went wrong rescanning. Please try again.' }).catch(() => {});
        await editOriginalResponse(interaction.application_id, interaction.token, { components: rescanComponents() }).catch(() => {});
      })
    );
    return;
  }

  // Suggestions as someone types into oldign -- answered inline (Discord
  // allows no deferring here), at most 25, each name capped at Discord's
  // 100-character limit.
  if (interaction.type === 4 /* APPLICATION_COMMAND_AUTOCOMPLETE */ && interaction.data?.name === 'uniongr') {
    const top = interaction.data.options || [];
    const focused = (top[0]?.type === 1 ? top[0].options || [] : top).find((o) => o.focused);
    let names = [];
    if (focused?.name === 'oldign') {
      names = await findKnownMemberNames(String(focused.value || '').trim(), 25).catch((err) => {
        console.error('oldign autocomplete failed:', err);
        return [];
      });
    } else if (focused?.name === 'ign' && top[0]?.name === 'same-ign') {
      // Suggests names already on the Growth Rate list so a returning member
      // matches their entry exactly (and their class/guild/lamp carry over).
      // A first-timer just keeps typing their own name -- it isn't limited
      // to these suggestions.
      const search = String(focused.value || '').trim();
      names = await sql`
        SELECT DISTINCT ON (LOWER(TRIM(ign))) TRIM(ign) AS name FROM growth_submissions
        WHERE POSITION(LOWER(${search}) IN LOWER(ign)) > 0
        ORDER BY LOWER(TRIM(ign)) LIMIT 25
      `.then(({ rows }) => rows.map((r) => r.name)).catch((err) => {
        console.error('ign autocomplete failed:', err);
        return [];
      });
    }
    return res.json({ type: 8 /* APPLICATION_COMMAND_AUTOCOMPLETE_RESULT */, data: { choices: names.map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })) } });
  }

  // Unknown interaction type/command -- acknowledge harmlessly rather than
  // leaving Discord to report "did not respond".
  res.json({ type: 1 });
}

module.exports = { handleDiscordInteraction, postChannelMessage, restickGrowthGuide, processAttendanceMessage };
