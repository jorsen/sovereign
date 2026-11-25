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
const { resolveEventTime, saveAttendanceRecord, saveLootToRecord, replaceAttendanceRecord, loadKnownItems, wallToUnix, unixToWall, removeAttendees, loadKillRecord, loadKillLoot, setLootQuantity } = require('./attendanceRecords');
const { readLootList, mergeLootScreenshots, iconDistance, iconDistancePart, shapeDistance } = require('./lootOcr');
const { completeItemName, lootKey, itemFromIcon } = require('./lootMatch');
const { textLang } = require('./gameText');
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
  return res.json().catch(() => null);
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
    WHERE schedule IN ('world_boss', 'balthazard', 'aegis') AND event_date >= now() - make_interval(days => ${ATTEND_RATE_DAYS})
  `;
  const kills = killRows[0].n;
  let attendRate;
  if (kills >= ATTEND_RATE_MIN_KILLS) {
    const { rows } = await sql`
      SELECT LOWER(TRIM(wa.member_name)) AS name, COUNT(DISTINCT a.id)::int AS n
      FROM world_boss_attendees wa JOIN world_boss_attendance a ON a.id = wa.attendance_id
      WHERE a.schedule IN ('world_boss', 'balthazard', 'aegis') AND a.event_date >= now() - make_interval(days => ${ATTEND_RATE_DAYS})
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
  let entries, legend, names = [], unsure = [];
  if (roster) {
    // Every sighting from every screenshot, each with all its OCR readings.
    // Only real members are listed: a ❓ reading (nothing on the list fits)
    // is a scrap of a hidden or blurred nameplate or an effect, not an
    // attendee, so it's left out of the post entirely (and never saved).
    const self = findSubmitterOnList(submitterNames, roster);
    const selfReading = self ? [{ name: self, alternatives: [], color: 'self', uncertain: false }] : [];
    const matched = matchToRoster([...perScreenshot.flat(), ...selfReading], roster, trainer).filter((n) => n.status !== 'unknown');
    // Strict: only sure matches are attendees -- read exactly, or matched
    // by several readings agreeing. A ⚠️ guess (the closest Growth Rate name
    // to a blurry or junk reading: "Fallin" -> 卍Allen卍) is never saved on
    // its own; it's offered as a ➕ button for a person to confirm.
    names = matched.filter((n) => n.status === 'exact' || n.confident);
    unsure = matched.filter((n) => !(n.status === 'exact' || n.confident));
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
  const fullList = entries.map((e) => `• ${e}`).join('\n') + (legend.length ? `\n\n${legend.join('\n')}` : '')
    + (unsure.length ? `\n\nNot sure, not saved: ${unsure.map((n) => escapeMarkdown(n.name)).join(', ')}` : '');
  const counts = perScreenshot.map((l) => l.length);
  const countText = counts.length === 1 ? `${counts[0]} from this screenshot` : `${counts.join(' + ')} from ${counts.length} screenshots`;
  // Names to save on the site: everyone matched to the Growth Rate list,
  // ⚠️ guesses included (they're real members); ❓ unknowns are left out,
  // since they're often misreads.
  const savable = names.map((n) => n.name);
  const hasUnknown = roster ? entries.some((e) => e.endsWith(' ❓')) : false;
  // matches: for the trainer -- which reading each saved member came from.
  return { entries, legend, fullList, countText, savable, hasUnknown, matches: names, unsure };
}

const SITE_URL = (process.env.SITE_URL || 'https://sovereign-nightcrows.vercel.app').replace(/\/+$/, '');

// Saves the scan as a World Boss / Balthazard record (or adds it onto the
// same kill's record) and returns the lines saying so, for the post and
// the thread. A save failure doesn't stop the list from being posted.
async function saveScanToSite(boss, when, scan, loggedBy) {
  if (!scan.savable.length) return scan.hasUnknown ? [multi('unknownNotSaved')] : [];
  const page = boss.schedule === 'world_boss' ? 'worldboss' : boss.schedule;
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
// When no loot list turned up, this many screenshots (fewest names first)
// are checked for one anyway.
const LOOT_RECHECK_SHOTS = 3;
// Image guard for the loot: the loot list says how many rows it holds
// ("Stored Quantity 10/100" at the bottom). After merging the screenshots
// (overlaps of a scrolled list counted once), the rows read should be that
// many; fewer = rows missed (not screenshotted, or unreadable), more = rows
// counted twice. Null when no screenshot shows the Stored Quantity.
const LOOT_CHECK_TITLE = '⚠️ Loot check';
function lootRowCheck(read, lists) {
  const stored = Math.max(0, ...lists.map((l) => l.stored || 0));
  if (!stored) return null;
  if (read === stored) return { ok: true, text: `✅ all ${stored} loot rows read (Stored Quantity ${stored})` };
  return {
    ok: false,
    text: read < stored
      ? `Read **${read}** loot rows; the storage holds **${stored}** (Stored Quantity). Fine if the rest is other bosses' loot. If this boss's rows go further, some are missing: 🎁 Add loot with links to ALL its loot screenshots (scroll so every row is on one).`
      : `Read **${read}** loot rows, but Stored Quantity is **${stored}**: some may be counted twice. Check the loot before saving.`,
  };
}
async function splitLootScreenshots(buffers, { deep = false, onShot = null } = {}) {
  const lootLists = [];
  const nameLists = [];
  const shotOf = new Map(); // name list -> its screenshot
  for (const buffer of buffers) {
    if (onShot) await onShot(buffers.indexOf(buffer), buffers.length);
    let names = [];
    try {
      names = await readNamesFromScreenshot(buffer, { deep });
    } catch (err) {
      console.error('attendance name reading failed:', err);
      throw new AttendanceScanError('readFailed', err);
    }
    if (names.length >= BATTLE_MIN_NAMES) {
      nameLists.push(names);
      shotOf.set(names, buffers.indexOf(buffer));
      continue;
    }
    const rows = await readLootList(buffer).catch((err) => {
      console.error('loot list check failed, treating it as a battle screenshot:', err);
      return null;
    });
    if (rows) lootLists.push(rows);
    else nameLists.push(names);
  }
  // No loot list found: one may have been taken for a battle screenshot --
  // blue item names ("Fossa Twin Sword") read like party nameplates. Check
  // the screenshots with the fewest names, until one is a loot list.
  if (!lootLists.length) {
    const byFewest = nameLists.filter((names) => shotOf.has(names)).sort((a, b) => a.length - b.length);
    for (const names of byFewest.slice(0, LOOT_RECHECK_SHOTS)) {
      const rows = await readLootList(buffers[shotOf.get(names)]).catch(() => null);
      if (rows) {
        lootLists.push(rows);
        nameLists.splice(nameLists.indexOf(names), 1);
      }
    }
  }
  const lootRows = mergeLootScreenshots(lootLists);
  return { lootRows, lootShots: lootLists.length, nameLists, lootCheck: lootRowCheck(lootRows.length, lootLists) };
}

// Loot rows -> one group per kill, item names completed against the site's
// item list and totaled. Rows of one boss within LOOT_SAME_KILL_MINUTES of
// each other are one kill -- Ducas and Dergio drop at 11:00 and 11:01 --
// using the earliest time. A row whose item can't be placed and has fewer
// than 5 letters ("TS a") is a scrap of the row, not an item, and is dropped.
const LOOT_SAME_KILL_MINUTES = 30;
// A row with no readable name ("" from the loot reader) is named by its
// icon: the same icon as a named row on the list (same item), else an icon
// learned off past records, else a reference picture. Within 10 of a named
// row counts as the same item (same item ~0-9, others 12+ apart).
const NAMELESS_SAME_ICON = 10;
const NAMELESS_SAME_SHAPE = 0.62; // same item 0.3-0.59 apart, Cape vs Inner Armor 0.66+
const NO_NAME = "(no name)";
function nameFromIcon(row, named, icons) {
  if (!row.icon) return null;
  let best = null;
  for (const n of named) {
    if (!n.icon) continue;
    const d = iconDistance(row.icon, n.icon);
    // The shape must agree too: Golden Cape and Golden Inner Armor Insignia
    // Fragments are close in color (8-12) but not in shape (0.66+).
    if (row.iconShape && n.shape && shapeDistance(row.iconShape, n.shape) > NAMELESS_SAME_SHAPE) continue;
    if (d <= NAMELESS_SAME_ICON && (!best || d < best.d)) best = { d, name: n.name };
  }
  return best?.name || itemFromIcon({ icon: row.icon, shape: row.iconShape, icons }) || nameFromHalfIcon(row, named, icons);
}
// Last try, for a row cut off at the list's edge: only the visible half of
// its icon (top half for the bottom row, bottom half for the top row)
// against every known icon -- named rows on the list, learned icons, the
// reference pictures. One item must be clearly closest: within 8, and every
// other item 12+ further (Damiross's cut-off Seal: 5.9 vs 27+).
const HALF_ICON_MAX = 8;
const HALF_ICON_LEAD = 12;
function nameFromHalfIcon(row, named, icons) {
  const known = [
    ...named.map((n) => ({ name: n.name, icon: n.icon })),
    ...[...(icons || new Map())].flatMap(([name, list]) => list.map((icon) => ({ name, icon }))),
    ...REFERENCE_ICON_LIST.map((r) => ({ name: r.name, icon: r.color })),
  ].filter((k) => k.icon);
  for (const [from, to] of [[0, 3], [3, 6]]) {
    const bestByName = new Map();
    for (const k of known) {
      const d = iconDistancePart(row.icon, k.icon, from, to);
      if (d < (bestByName.get(k.name) ?? Infinity)) bestByName.set(k.name, d);
    }
    const [first, second] = [...bestByName].sort((a, b) => a[1] - b[1]);
    if (first && first[1] <= HALF_ICON_MAX && (!second || second[1] - first[1] >= HALF_ICON_LEAD)) return first[0];
  }
  return null;
}
const REFERENCE_ICON_LIST = require('./itemIcons.json');
function buildLootGroups(rows, knownItems, learnedItems, icons) {
  const minutes = (wall) => Date.parse(wall + ':00Z') / 60000;
  const groups = [];
  const sorted = [...rows].sort((a, b) => a.wall.localeCompare(b.wall));
  const named = []; // rows named by their text: their icons name nameless twins
  const results = sorted.map((row) => {
    if (!row.fragment) return null;
    const done = completeItemName(row.fragment, row.boss.boss, knownItems, learnedItems, { icon: row.icon, shape: row.iconShape, icons });
    if (done.matched && done.byText !== false) named.push({ icon: row.icon, shape: row.iconShape, name: done.name });
    return done;
  });
  sorted.forEach((row, idx) => {
    let group = groups.find((g) => g.boss.boss === row.boss.boss && minutes(row.wall) - minutes(g.wall) <= LOOT_SAME_KILL_MINUTES);
    if (!group) groups.push((group = { boss: row.boss, wall: row.wall, items: new Map() }));
    let done = results[idx];
    if (!row.fragment) {
      // No name on screen: the icon decides, or it's listed as "(no name) ❓"
      // -- shown, never silently dropped, never saved.
      const byIcon = nameFromIcon(row, named, icons);
      done = byIcon
        ? { name: byIcon, matched: true, confident: false, byText: false, byIcon: true }
        : { name: NO_NAME, matched: false, confident: false };
    } else if (!done.matched) {
      // Text that matches no item is OCR junk off the name ("bi Sa", "Seen
      // Oe" for Golden Cape Insignia Fragment): the icon names it if it can.
      const byIcon = nameFromIcon(row, named, icons);
      if (byIcon) done = { name: byIcon, matched: true, confident: false, byText: false, byIcon: true };
      // (A Thai or Chinese name is a name, however short: "冰凍之淚" is 4.)
      else if (!textLang(row.fragment) && (row.fragment.match(/[A-Za-z]/g) || []).length < 5) return;
    }
    const itemKey = done.matched ? done.name : `?${(row.fragment || NO_NAME).toLowerCase()}`;
    const item = group.items.get(itemKey) || { name: done.name, fragment: row.fragment || NO_NAME, matched: done.matched, confident: done.confident, byText: done.byText, byIcon: done.byIcon, candidates: done.candidates, icons: [], quantity: 0 };
    item.quantity += row.quantity;
    item.iconRows = (item.iconRows || 0) + (done.byIcon ? row.quantity : 0); // named by icon, not text
    item.confident = item.confident && done.confident;
    item.byText = item.byText && done.byText;
    if (row.icon) item.icons.push(row.icon);
    group.items.set(itemKey, item);
  });
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
  let attachments = rescanMessage
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
    await editOriginalResponse(applicationId, token, { components: restoredComponents(rescanMessage) });
  };

  // /api/discord-interactions skips the site's schema middleware; make sure
  // every table exists (cached per instance), incl. the trainer's.
  await ensureSchema().catch((err) => console.error('/attendance could not prepare the database:', err));
  const boss = findBossInText(bossText);
  if (!boss) return void (await failWith(unknownBossText(bossText)));
  // link: images from Discord message links / image links, after any
  // attached screenshots; 10 in all at most.
  if (!rescanMessage && getOpt('link')) {
    try {
      attachments.push(...(await imagesFromLinks(getOpt('link'))));
    } catch (err) {
      if (!(err instanceof LinkError)) throw err;
      return void (await failWith(multi('linkFailed', { link: err.link })));
    }
    attachments.splice(10);
  }
  if (!attachments.length) return void (await failWith(multi('needScreenshots')));
  if (attachments.some((a) => !(a.content_type || '').startsWith('image/'))) {
    return void (await failWith(multi('invalidAttachment')));
  }
  let buffers;
  try {
    buffers = await downloadScreenshots(attachments.map((a) => a.url));
  } catch (err) {
    if (!(err instanceof AttendanceScanError)) throw err;
    return void (await failWith(multi(err.key)));
  }
  // The same screenshot twice (uploaded or linked again, or a re-save of
  // it): read once, posted once, counted once. On a rescan, extra copies
  // already on the post are dropped from it.
  const duplicates = await findDuplicateShots(buffers);
  if (duplicates.size) {
    buffers = buffers.filter((_, i) => !duplicates.has(i));
    attachments = attachments.filter((_, i) => !duplicates.has(i));
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
  // Rescan: names someone confirmed with a ➕ button stay -- a person saw
  // them on the screenshot, whatever this read makes of them.
  const confirmed = rescanMessage ? confirmedNames(rescanMessage) : [];
  if (confirmed.length) {
    if (!scan) scan = { entries: [], savable: [], matches: [], unsure: [] };
    for (const name of confirmed) {
      scan.unsure = scan.unsure.filter((n) => n.name.toLowerCase() !== name.toLowerCase());
      if (scan.savable.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
      scan.savable.push(name);
      scan.entries.push(`${escapeMarkdown(name)}${CONFIRMED_MARK}`);
    }
  }
  const unsure = scan?.unsure || [];
  const entries = scan?.entries || [];
  if (!entries.length && !lootGroups.length) return void (await failWith(multi('noNames')));

  // Save: sure attendees only (not ⚠️ guesses or ❓) and each kill's loot.
  // Normally this adds to the kill's record (a second screenshot of the
  // same fight). With rescan:True it replaces what was saved for this kill
  // instead -- the way to correct a wrong scan.
  const notes = [];
  // Loot image guard (Stored Quantity vs rows read), in the footer.
  if (split.lootCheck) notes.push(split.lootCheck.ok ? split.lootCheck.text : `⚠️ ${split.lootCheck.text.replace(/\*\*/g, '')}`);
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
  // screenshots themselves. Only sure names are attendees; guesses (the
  // closest Growth Rate name to a blurry reading) are listed under "Not
  // sure" with a ➕ button each, and saved only when someone presses it.
  // Loot items not on the site's list keep a ❓, since those are not saved.
  const anyUnknown = loot.some((l) => l.group.items.some((i) => !i.matched));
  const shotCount = `${duplicates.size ? `${duplicates.size} duplicate screenshot${duplicates.size === 1 ? "" : "s"} skipped · ` : ""}${buffers.length} screenshot${buffers.length === 1 ? "" : "s"} read${lootShots ? ` (${lootShots} loot list${lootShots === 1 ? "" : "s"})` : ""}`;
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

  const page = boss.schedule === 'world_boss' ? 'worldboss' : boss.schedule;
  const embed = {
    color: 0xe74c3c,
    url: `${SITE_URL}/#${page}`, // also groups the screenshots below into one gallery
    fields: [
      { name: 'Boss', value: escapeMarkdown(boss.boss), inline: true },
      { name: 'Time of Death', value: `<t:${when.unix}:F>`, inline: true },
      ...listFields(`Attendees List (${entries.length})`, attendeeLines),
      ...(unsure.length ? listFields(`${NOT_SURE_TITLE} (${unsure.length})`, unsure.map(unsureLine)) : []),
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
      components: postComponents(when.wall, unsure),
    });
    if (!posted) posted = await editOriginalResponse(applicationId, token, { embeds: [embed], attachments: kept, components: postComponents(when.wall, unsure) });
    if (saveWarning) await markDone(posted, '⚠️');
    return;
  }

  // The screenshots themselves, re-uploaded with the post (the links Discord
  // gives for command attachments expire).
  const files = await screenshotsForPost(buffers);
  let posted = await editOriginalResponseWithFiles(applicationId, token, { embeds: screenshotEmbeds(embed, files.map((f) => f.filename)), components: postComponents(when.wall, unsure) }, files);
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

// Screenshots that are the same picture -- byte for byte, or the same shot
// re-saved (WebP vs PNG, resized): a 32x32 greyscale thumbnail differs by
// almost nothing. Returns the indexes of the later copies.
// Measured: re-saved copies 1.0-1.6; a loot list scrolled by one row 4.8;
// battle shots a second apart 22. Copies must also have the same shape.
const DUPLICATE_SHOT_DIFF = 2; // mean grey difference, 0-255
async function shotThumb(buffer) {
  const img = sharp(buffer).rotate();
  const { width, height } = await img.metadata();
  const px = await img.resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer();
  return { px, ratio: width / height };
}
async function findDuplicateShots(buffers) {
  const thumbs = await Promise.all(buffers.map((b) => shotThumb(b).catch(() => null)));
  const dup = new Set();
  thumbs.forEach((t, i) => {
    if (!t) return;
    for (let j = 0; j < i; j++) {
      if (dup.has(j) || !thumbs[j]) continue;
      if (Math.abs(t.ratio / thumbs[j].ratio - 1) > 0.02) continue;
      let sum = 0;
      for (let k = 0; k < t.px.length; k++) sum += Math.abs(t.px[k] - thumbs[j].px[k]);
      if (sum / t.px.length <= DUPLICATE_SHOT_DIFF) {
        dup.add(i);
        return;
      }
    }
  });
  return dup;
}

// /attendance link: -- screenshots taken straight from Discord messages
// instead of re-uploading them. Accepts message links
// (discord.com/channels/<server>/<channel>/<message>, several separated by
// spaces) and direct image links (cdn.discordapp.com/attachments/...).
// A message's images are its attachments plus any image links it shows.
const MESSAGE_LINK = /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/g;
const DIRECT_IMAGE_LINK = /https?:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/attachments\/\d+\/\d+\/[^\s<>?]+(?:\?[^\s<>]*)?/g;
class LinkError extends Error {
  constructor(link) {
    super(`could not read ${link}`);
    this.link = link;
  }
}
const discordGet = (path) => fetchWithRetry(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } });
const asImage = (url, filename, contentType) => ({ url, filename: filename || new URL(url).pathname.split('/').pop(), content_type: contentType || 'image/png' });
// A copied "media.discordapp.net/...&format=webp&width=1280" link serves a
// shrunk, recompressed copy -- names come out too small to read (4 of 23
// lost on a Ducas post). The same file at full size: cdn.discordapp.com,
// keeping only the signature (ex/is/hm).
function originalImageUrl(link) {
  try {
    const url = new URL(link);
    url.hostname = 'cdn.discordapp.com';
    for (const key of [...url.searchParams.keys()]) if (!['ex', 'is', 'hm'].includes(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return link;
  }
}
// A Discord image link or message link in the text (screenshots by link).
function hasScreenshotLinks(text) {
  const s = String(text || '');
  return new RegExp(MESSAGE_LINK.source).test(s) || new RegExp(DIRECT_IMAGE_LINK.source).test(s);
}
async function imagesFromLinks(text) {
  const images = [];
  const s = String(text || '');
  for (const [link, channelId, messageId] of s.matchAll(MESSAGE_LINK)) {
    const res = await discordGet(`/channels/${channelId}/messages/${messageId}`).catch(() => null);
    if (!res?.ok) throw new LinkError(link);
    const msg = await res.json();
    const found = [
      ...(msg.attachments || []).filter((a) => (a.content_type || '').startsWith('image/') || IMAGE_FILE.test(a.filename || '')).map((a) => asImage(a.url, a.filename, a.content_type || 'image/png')),
      ...(msg.embeds || []).map((e) => e.image?.url || (e.type === 'image' ? e.thumbnail?.url : null)).filter(Boolean).map((u) => asImage(u)),
    ];
    if (!found.length) throw new LinkError(link);
    images.push(...found);
  }
  // Direct image links carry an expiring signature; Discord hands out fresh
  // ones for the same file.
  const direct = [...s.matchAll(DIRECT_IMAGE_LINK)].map((m) => originalImageUrl(m[0]));
  if (direct.length) {
    const res = await fetchWithRetry('https://discord.com/api/v10/attachments/refresh-urls', {
      method: 'POST',
      headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachment_urls: direct }),
    }).catch(() => null);
    const fresh = res?.ok ? (await res.json()).refreshed_urls || [] : [];
    for (const url of direct) images.push(asImage(fresh.find((f) => f.original === url)?.refreshed || url));
  }
  return images;
}
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
    components: [
      { type: 2, style: 2, custom_id: RESCAN_BUTTON_ID, emoji: { name: '🔄' }, label: running ? 'Rescanning…' : 'Rescan', disabled: running },
      // Someone the scan missed entirely (a name hidden behind another).
      { type: 2, style: 2, custom_id: ADD_MEMBER_BUTTON_ID, label: '➕ Add member', disabled: running },
      // Someone on the list who wasn't there (added by mistake).
      { type: 2, style: 2, custom_id: REMOVE_MEMBER_BUTTON_ID, label: '➖ Remove', disabled: running },
      // Add, change or remove loot by hand.
      lootButton(running),
    ],
  }];
}
const ADD_MEMBER_BUTTON_ID = 'attendance:addmember';
const REMOVE_MEMBER_BUTTON_ID = 'attendance:remove';
const LOOT_BUTTON_ID = 'attendance:loot';
function lootButton(disabled = false) {
  return { type: 2, style: 2, custom_id: LOOT_BUTTON_ID, label: '🎁 Loot', disabled };
}

// 🎁 Loot on a saved post: a private loot editor for that kill. A dropdown
// of its items -- pick one to change how many dropped (0 takes it off) --
// and ➕ Add item, which finds the item by name (or part of it) among the
// names the site knows, or saves it as typed. Every change is saved to the
// kill's record at once and the post's Loots list is rewritten to match.
// Items with a price or a sale on the site are 🔒: part of a payout, so
// they're changed on the site, not here. The editor's ids carry the post's
// channel and message (the "postRef"), like ➕ Add member's picker.
const LOOT_PICK_PREFIX = 'attendance:lpick:';   // + postRef            dropdown: item to change
const LOOT_QTY_PREFIX = 'attendance:lqty:';     // + postRef:rowId      form: its new quantity
const LOOT_ADD_PREFIX = 'attendance:ladd:';     // + postRef            button: ➕ Add item
const LOOT_ADD_FORM_PREFIX = 'attendance:laddf:'; // + postRef          form: name + quantity
const LOOT_CHOOSE_PREFIX = 'attendance:lch:';   // + postRef:quantity   dropdown: which item was meant
const LOOT_MAX_QUANTITY = 99999;
const squashItem = (n) => String(n).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function parsePostRefTail(cid, prefix) {
  const [channelId, messageId, tail] = cid.slice(prefix.length).split(':');
  return { postRef: `${channelId}:${messageId}`, tail };
}

function lootEditorMessage(postRef, loot, { status = '', choose = null } = {}) {
  const items = loot?.items || [];
  const total = items.reduce((s, i) => s + i.quantity, 0);
  const lines = items.map((i) => `• ${escapeMarkdown(i.name)} ×${i.quantity}${i.locked ? ' 🔒' : ''}`);
  const content = [
    status,
    `**Loot on this kill (${total}):**`,
    lines.length ? lines.join('\n') : '_none yet_',
    items.some((i) => i.locked) ? '🔒 = has a price or sale on the website -- change it there.' : '',
    'Pick an item below to change how many dropped (0 removes it), or **➕ Add item**.',
  ].filter(Boolean).join('\n').slice(0, 2000);
  const editable = items.filter((i) => !i.locked).slice(0, 25);
  const components = [];
  if (choose) components.push(choose);
  if (editable.length) {
    components.push({ type: 1, components: [{
      type: 3, custom_id: `${LOOT_PICK_PREFIX}${postRef}`, placeholder: 'Change or remove an item…', min_values: 1, max_values: 1,
      options: editable.map((i) => ({ label: i.name.slice(0, 100), value: i.key, description: `×${i.quantity} now` })),
    }] });
  }
  components.push({ type: 1, components: [{ type: 2, style: 3, custom_id: `${LOOT_ADD_PREFIX}${postRef}`, label: '➕ Add item' }] });
  return { flags: 64, content, components };
}

function lootQuantityForm(postRef, item) {
  return {
    type: 9 /* MODAL */,
    data: {
      custom_id: `${LOOT_QTY_PREFIX}${postRef}:${item.key}`,
      title: `How many: ${item.name}`.slice(0, 45),
      components: [{ type: 1, components: [{
        type: 4, custom_id: 'qty', style: 1, required: true, min_length: 1, max_length: 5,
        label: 'How many dropped (0 removes it)', value: String(item.quantity),
      }] }],
    },
  };
}

function lootAddForm(postRef) {
  return {
    type: 9 /* MODAL */,
    data: {
      custom_id: `${LOOT_ADD_FORM_PREFIX}${postRef}`,
      title: 'Add loot',
      components: [
        { type: 1, components: [{ type: 4, custom_id: 'name', style: 1, required: true, min_length: 2, max_length: 100, label: 'Item name, or part of it', placeholder: 'e.g. golden cape' }] },
        { type: 1, components: [{ type: 4, custom_id: 'qty', style: 1, required: true, min_length: 1, max_length: 5, label: 'How many', value: '1' }] },
      ],
    },
  };
}

function formValue(interaction, id) {
  for (const row of interaction.data?.components || []) for (const c of row.components || []) if (c.custom_id === id) return String(c.value || '').trim();
  return '';
}
function parseQuantity(text) {
  return /^\d{1,5}$/.test(text) && Number(text) <= LOOT_MAX_QUANTITY ? Number(text) : null;
}

// Item names the site knows that match what was typed: an exact name
// (ignoring case, spaces and punctuation) alone, else every name containing
// it -- the ones this boss has dropped before first.
async function findLootItems(typed, boss) {
  const key = squashItem(typed);
  if (!key) return [];
  const known = await loadKnownItems().catch(() => []);
  const score = new Map();
  for (const r of known) {
    const s = score.get(r.name) || 0;
    score.set(r.name, s + (r.boss === boss.boss ? r.count * 1000 : r.count));
  }
  const names = [...score.keys()];
  const exact = names.find((n) => squashItem(n) === key);
  if (exact) return [exact];
  return names.filter((n) => squashItem(n).includes(key))
    .sort((a, b) => score.get(b) - score.get(a) || a.localeCompare(b));
}

// The dropdown shown when the typed name fits several items (or none): the
// matches, plus "save as typed" for an item the site doesn't know yet.
function lootChooseRow(postRef, typed, quantity, matches) {
  const options = matches.slice(0, 24).map((n) => ({ label: n.slice(0, 100), value: `=${n}`.slice(0, 100) }));
  options.push({ label: `New item, as typed: ${typed}`.slice(0, 100), value: `+${typed}`.slice(0, 100), description: 'Not a name the site knows -- check the spelling', emoji: { name: '🆕' } });
  return { type: 1, components: [{
    type: 3, custom_id: `${LOOT_CHOOSE_PREFIX}${postRef}:${quantity}`,
    placeholder: matches.length ? `Which "${typed}" ×${quantity}?`.slice(0, 150) : `No known item has "${typed}"`.slice(0, 150),
    min_values: 1, max_values: 1, options,
  }] };
}

// Rewrites the post's Loots list from the record (screenshots, attendees and
// buttons stay); the Loot check from the scan goes, since a person has now
// set the loot by hand.
async function refreshPostLoot(postRef, loot, presser) {
  const [channelId, messageId] = postRef.split(':');
  const post = await loadPost(postRef);
  const embed0 = post.embeds?.[0] || {};
  const fields = embed0.fields || [];
  const items = loot?.items || [];
  const lootLines = items.map((i) => `${escapeMarkdown(i.name)} ×${i.quantity}`);
  const firstLoot = fields.findIndex((f) => f.name.startsWith('Loots'));
  const rest = fields.filter((f) => !f.name.startsWith('Loots') && f.name !== LOOT_CHECK_TITLE);
  const at = firstLoot < 0 ? rest.length : fields.slice(0, firstLoot).filter((f) => !f.name.startsWith('Loots') && f.name !== LOOT_CHECK_TITLE).length;
  const footer = String(embed0.footer?.text || '');
  const embed = {
    color: embed0.color,
    url: embed0.url,
    author: embed0.author?.name ? { name: embed0.author.name } : embed0.title ? { name: embed0.title } : undefined,
    fields: [...rest.slice(0, at), ...listFields(`Loots (${items.reduce((s, i) => s + i.quantity, 0)})`, lootLines), ...rest.slice(at)]
      .map((f) => ({ name: f.name, value: f.value, inline: f.inline })).slice(0, 25),
    footer: { text: `${footer}${footer.includes(`🎁 by ${presser}`) ? '' : ` · 🎁 by ${presser}`}`.slice(0, 2048) },
  };
  const attachments = postScreenshots(post);
  await editChannelMessage(channelId, messageId, {
    embeds: screenshotEmbeds(embed, attachments.map((a) => a.filename)),
    attachments: attachments.map((a) => ({ id: a.id })),
    components: restoredComponents(post),
  });
}

// The kill a post is about, or an error for the presser.
async function lootKill(postRef) {
  const post = await loadPost(postRef);
  const { boss, wall } = postKill(post);
  if (!boss || !wall) throw new Error('attendance post has no boss/time');
  return { boss, wall };
}

// One change from the editor: saved, the post rewritten, the editor redrawn.
async function applyLootChange({ applicationId, token, postRef, name, quantity, member, user, add = false }) {
  const { boss, wall } = await lootKill(postRef);
  const presser = presserName(member, user);
  let target = quantity;
  if (add) {
    const current = (await loadKillLoot(boss, wall))?.items.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
    if (current?.locked) target = null;
    else target = (current?.quantity || 0) + quantity;
  }
  const result = target === null ? { ok: false, reason: 'locked' } : await setLootQuantity({ boss, wall, name, quantity: Math.min(target, LOOT_MAX_QUANTITY), loggedBy: presser });
  const loot = await loadKillLoot(boss, wall);
  let status;
  if (!result.ok) status = `🔒 **${escapeMarkdown(name)}** has a price or sale on the website -- change it there.`;
  else {
    await refreshPostLoot(postRef, loot, presser);
    status = result.after === 0 ? `✅ Removed **${escapeMarkdown(name)}**.`
      : result.before === 0 ? `✅ Added **${escapeMarkdown(name)} ×${result.after}**.`
      : `✅ **${escapeMarkdown(name)}**: ×${result.before} → ×${result.after}.`;
  }
  await editOriginalResponse(applicationId, token, lootEditorMessage(postRef, loot, { status }));
}

// ➖ Remove: a private picker of the post's attendees -- tick everyone who
// wasn't there, then 🗑️ Remove takes them all off the record and the post.
// Like ➕ Add member, the picks live in the picker's own selected options.
const RM_PICK_PREFIX = 'attendance:rmpick:';
const RM_CONFIRM_PREFIX = 'attendance:rmok:';
// The post's attendees, as written (✔ and numbering stripped, unescaped).
function attendeesOn(post) {
  return (post?.embeds?.[0]?.fields || [])
    .filter((f) => f.name.startsWith('Attendees List'))
    .flatMap((f) => (f.value === '—' ? [] : String(f.value).split('\n')))
    .map((l) => l.replace(/^\d+\.\s+/, '').replace(/\s*✔$/, '').replace(/\\([\\*_~`|>])/g, '$1').trim())
    .filter(Boolean);
}
function removerContent(picked) {
  return picked.length
    ? `**Remove (${picked.length}):** ${picked.map(escapeMarkdown).join(', ')}\nPress **🗑️ Remove** to take them off the record.`
    : 'Tick everyone who was **not** there (several at once is fine). Nothing changes until you press 🗑️ Remove.';
}
function removerButtons(postRef, picked) {
  return { type: 1, components: [
    { type: 2, style: 4, custom_id: `${RM_CONFIRM_PREFIX}${postRef}`, emoji: { name: '🗑️' }, label: picked.length ? `Remove ${picked.length}` : 'Remove', disabled: !picked.length },
  ] };
}
function removerMessage(postRef, names, picked = []) {
  const rows = [];
  for (let i = 0; i < names.length && rows.length < 4; i += 25) {
    const chunk = names.slice(i, i + 25);
    rows.push({ type: 1, components: [{
      type: 3, custom_id: `${RM_PICK_PREFIX}${postRef}:${rows.length}`,
      placeholder: names.length > 25 ? `Attendees (${i + 1}-${i + chunk.length})` : 'Attendees',
      min_values: 0, max_values: chunk.length,
      options: chunk.map((n) => ({ label: n.slice(0, 100), value: n.slice(0, 100), default: picked.includes(n) })),
    }] });
  }
  return { flags: 64, content: names.length ? removerContent(picked) : 'Nobody is on this post yet.', components: names.length ? [...rows, removerButtons(postRef, picked)] : [] };
}
function repickedRemover(message, changed) {
  const picked = pickedIn(message, changed);
  const postRef = changed.id.slice(RM_PICK_PREFIX.length).split(':').slice(0, 2).join(':');
  return {
    content: removerContent(picked),
    components: (message.components || []).map((row) => {
      const c = row.components?.[0];
      if (c?.type !== 3) return null;
      return { type: 1, components: [{
        type: 3, custom_id: c.custom_id, placeholder: c.placeholder, min_values: 0, max_values: c.max_values,
        options: (c.options || []).map((o) => ({ label: o.label, value: o.value, default: picked.includes(o.value) })),
      }] };
    }).filter(Boolean).concat(removerButtons(postRef, picked)),
  };
}
// 🗑️ Remove pressed: off the record, then off the post (renumbered).
async function removePickedMembers({ postRef, names, member, user }) {
  const [channelId, messageId] = postRef.split(':');
  const post = await loadPost(postRef);
  const { boss, wall } = postKill(post);
  if (!boss || !wall) throw new Error('attendance post has no boss/time');
  const presser = presserName(member, user);
  const result = await removeAttendees({ boss, wall, names, loggedBy: presser });
  if (!result) throw new Error('no saved record for this kill');
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const embed0 = post.embeds?.[0] || {};
  const fields = embed0.fields || [];
  const kept = fields.filter((f) => f.name.startsWith('Attendees List'))
    .flatMap((f) => (f.value === '—' ? [] : String(f.value).split('\n')))
    .filter((l) => !lower.has(l.replace(/^\d+\.\s+/, '').replace(/\s*✔$/, '').replace(/\\([\\*_~`|>])/g, '$1').trim().toLowerCase()))
    .map((l, i) => l.replace(/^\d+\./, `${i + 1}.`));
  const first = fields.findIndex((f) => f.name.startsWith('Attendees List'));
  const rest = fields.filter((f) => !f.name.startsWith('Attendees List'));
  const at = first < 0 ? rest.length : first;
  const footer = String(embed0.footer?.text || '');
  const embed = {
    color: embed0.color,
    url: embed0.url,
    // The post's heading line, kept (a saved Review's "Saved ✅ ...").
    author: embed0.author?.name ? { name: embed0.author.name } : embed0.title ? { name: embed0.title } : undefined,
    fields: [...rest.slice(0, at), ...listFields(`Attendees List (${kept.length})`, kept), ...rest.slice(at)].slice(0, 25),
    footer: { text: `${footer}${footer.includes(`➖ by ${presser}`) ? '' : ` · ➖ by ${presser}`}`.slice(0, 2048) },
  };
  const attachments = postScreenshots(post);
  await editChannelMessage(channelId, messageId, {
    embeds: screenshotEmbeds(embed, attachments.map((a) => a.filename)),
    attachments: attachments.map((a) => ({ id: a.id })),
    components: restoredComponents(post),
  });
  return result;
}

// Names the bot wasn't sure of (a ⚠️ guess): not saved, listed under "Not
// sure" with a ➕ button each. Pressing it adds that member to the kill's
// record and moves them to the Attendees List, marked ✔ (confirmed by a
// person), which a later rescan keeps. Discord allows 5 rows of 5 buttons;
// the first row is 🔄 Rescan, so up to 20 names get a button.
const ADD_BUTTON_PREFIX = 'attendance:add:';
const NOT_SURE_TITLE = 'Not sure, not saved';
const CONFIRMED_MARK = ' ✔';
const MAX_ADD_BUTTONS = 20;
function unsureLine(n) {
  return `• ${escapeMarkdown(n.name)} (read as "${escapeMarkdown(String(n.readAs || '').slice(0, 40))}")`;
}
// custom_id (≤ 100 chars): the kill's time, the member, and the misreading
// it came from (for the trainer; dropped if it doesn't fit).
function addButtonId(wall, n) {
  const base = `${ADD_BUTTON_PREFIX}${wall}|${n.name}`;
  const full = `${base}|${n.readAs || ''}`;
  return full.length <= 100 ? full : base.slice(0, 100);
}
function parseAddButtonId(id) {
  const [wall, name, readAs] = id.slice(ADD_BUTTON_PREFIX.length).split('|');
  return { wall, name, readAs };
}
function postComponents(wall, unsure = []) {
  const buttons = unsure.slice(0, MAX_ADD_BUTTONS).map((n) => ({ type: 2, style: 1, custom_id: addButtonId(wall, n), label: `➕ ${n.name}`.slice(0, 80) }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return [...rescanComponents(), ...rows];
}
// The post's own buttons as they were, Rescan enabled again (a failed or
// crashed rescan puts them back; the ➕ buttons must not be lost).
function restoredComponents(message) {
  const rows = (message?.components || []).map((row) => ({
    type: 1,
    components: (row.components || []).filter((b) => b.type === 2).map((b) => ({ type: 2, style: b.style, custom_id: b.custom_id, label: b.label, ...(b.emoji ? { emoji: b.emoji } : {}) })),
  })).filter((row) => row.components.length);
  // An /attendance post's first row (🔄 Rescan, ➕, ➖) comes back fresh --
  // not stuck on "Rescanning…". A saved review post has no Rescan (its
  // screenshots are on the member's own message) and keeps its row as is.
  if (rows[0]?.components.some((b) => b.custom_id === RESCAN_BUTTON_ID)) rows[0] = rescanComponents()[0];
  // A saved post from before 🎁 Loot existed gets it next to ➕ / ➖.
  const memberRow = rows.find((row) => row.components.some((b) => b.custom_id === ADD_MEMBER_BUTTON_ID));
  if (memberRow && !memberRow.components.some((b) => b.custom_id === LOOT_BUTTON_ID) && memberRow.components.length < 5) memberRow.components.push(lootButton());
  return rows;
}
// Attendee names a person confirmed (✔) on a post.
function confirmedNames(message) {
  const fields = message?.embeds?.[0]?.fields || [];
  return fields
    .filter((f) => f.name.startsWith('Attendees List'))
    .flatMap((f) => String(f.value || '').split('\n'))
    .map((line) => line.match(/^\d+\.\s+(.+?)\s*✔$/)?.[1])
    .filter(Boolean)
    .map((name) => name.replace(/\\([\\*_~`|>])/g, '$1')); // undo escapeMarkdown
}

// The kill an attendance post is about: its boss and its Time of Death
// (<t:unix:F>) back as the guild's wall-clock time.
function postKill(message) {
  const fields = message?.embeds?.[0]?.fields || [];
  const boss = findBossInText(String(fields.find((f) => f.name === 'Boss')?.value || '').trim());
  const unix = String(fields.find((f) => f.name === 'Time of Death')?.value || '').match(/<t:(\d+)/)?.[1];
  return { boss, wall: unix ? unixToWall(unix) : null };
}
const presserName = (member, user) => member?.nick || member?.user?.global_name || member?.user?.username || user?.global_name || user?.username;

// ➕ pressed on a "Not sure" name: adds that member, and the trainer learns
// the misreading a person just confirmed.
async function confirmUnsureName({ applicationId, token, message, customId, member, user }) {
  const { wall, name, readAs } = parseAddButtonId(customId);
  const { boss } = postKill(message);
  if (!boss || !wall || !name) throw new Error(`bad add button: ${customId}`);
  await addNamesToPost({ message, boss, wall, names: [name], presser: presserName(member, user), training: readAs ? [{ name, readAs, status: 'corrected' }] : [], edit: (p) => editOriginalResponse(applicationId, token, p) });
}

// ➕ Add member: search first. The button opens a search box; the names
// matching what was typed show underneath as one dropdown (only Growth Rate
// names, so nothing can be misspelled). Pick one or more, 🔎 Search again
// for others -- picks add up -- then ✅ Add saves them all at once. The
// picker is private (only the presser sees it); its ids carry the post's
// channel and message, since adding edits that post.
const ADD_PICK_PREFIX = 'attendance:addpick:';
const ADD_SEARCH_PREFIX = 'attendance:addsearch:';
const ADD_SEARCH_FORM_PREFIX = 'attendance:addsearchform:';
const ADD_CONFIRM_PREFIX = 'attendance:addok:';
function searchForm(postRef) {
  return {
    type: 9 /* MODAL */,
    data: {
      custom_id: `${ADD_SEARCH_FORM_PREFIX}${postRef}`,
      title: 'Find who was missed',
      components: [{ type: 1, components: [{ type: 4, custom_id: 'q', style: 1, required: true, min_length: 1, max_length: 40, label: 'Name, or part of it', placeholder: 'e.g. jen' }] }],
    },
  };
}
// Every name picked so far: the dropdowns' selected options, with `changed`
// (the dropdown just used) taking its fresh values. The picks live in the
// picker message itself -- nothing stored anywhere else.
function pickedIn(message, changed = null) {
  const picked = [];
  for (const row of message?.components || []) {
    for (const c of row.components || []) {
      if (c.type !== 3) continue;
      picked.push(...(changed && c.custom_id === changed.id ? changed.values : (c.options || []).filter((o) => o.default).map((o) => o.value)));
    }
  }
  return [...new Set(picked)];
}
function pickerContent(picked, note) {
  return [
    note,
    picked.length
      ? `**Picked (${picked.length}):** ${picked.map(escapeMarkdown).join(', ')}\n🔎 Search again for more, or press **✅ Add** to save them all.`
      : 'Pick from the names below (several at once is fine). Nothing is saved until you press ✅ Add.',
  ].filter(Boolean).join('\n');
}
function pickerButtons(postRef, picked) {
  return { type: 1, components: [
    { type: 2, style: 3, custom_id: `${ADD_CONFIRM_PREFIX}${postRef}`, emoji: { name: '✅' }, label: picked.length ? `Add ${picked.length}` : 'Add', disabled: !picked.length },
    { type: 2, style: 2, custom_id: `${ADD_SEARCH_PREFIX}${postRef}`, emoji: { name: '🔎' }, label: 'Search again' },
  ] };
}
// The picker after a search: one dropdown of the matches, plus -- when
// earlier searches picked names not among them -- a "Picked" dropdown so
// they stay picked (untick there to drop one).
function pickerMessage(postRef, matches, { picked = [], query = '' } = {}) {
  const extra = picked.filter((n) => !matches.includes(n));
  const dropdowns = [
    ...(extra.length ? [{ title: `Picked so far (${extra.length})`, names: extra.slice(0, 25) }] : []),
    ...(matches.length ? [{ title: `Names with "${query}"`.slice(0, 150), names: matches.slice(0, 25) }] : []),
  ];
  const note = matches.length
    ? `Names with "${escapeMarkdown(query)}":`
    : `No Growth Rate name has "${escapeMarkdown(query)}" -- 🔎 Search again with fewer letters.`;
  return {
    flags: 64,
    content: pickerContent(picked, note),
    components: [
      // (Each dropdown needs its own id: the post's ref plus its number.)
      ...dropdowns.map((d, g) => ({ type: 1, components: [{
        type: 3, custom_id: `${ADD_PICK_PREFIX}${postRef}:${g}`, placeholder: d.title,
        min_values: 0, max_values: d.names.length,
        options: d.names.map((n) => ({ label: n.slice(0, 100), value: n.slice(0, 100), default: picked.includes(n) })),
      }] })),
      pickerButtons(postRef, picked),
    ],
  };
}
// A dropdown used: same picker, its selections and the Picked line updated.
function repickedPicker(message, changed) {
  const picked = pickedIn(message, changed);
  const postRef = changed.id.slice(ADD_PICK_PREFIX.length).split(':').slice(0, 2).join(':');
  const note = String(message.content || '').split('\n').find((l) => l.startsWith('Names with') || l.startsWith('No Growth Rate')) || null;
  return {
    content: pickerContent(picked, note),
    components: (message.components || []).map((row) => {
      const c = row.components?.[0];
      if (c?.type !== 3) return null;
      return { type: 1, components: [{
        type: 3, custom_id: c.custom_id, placeholder: c.placeholder, min_values: 0, max_values: c.max_values,
        options: (c.options || []).map((o) => ({ label: o.label, value: o.value, default: picked.includes(o.value) })),
      }] };
    }).filter(Boolean).concat(pickerButtons(postRef, picked)),
  };
}
// "Not sure" names on a post, with what the scan read them as.
function notSureOn(post) {
  return (post?.embeds?.[0]?.fields || [])
    .filter((f) => f.name.startsWith(NOT_SURE_TITLE))
    .flatMap((f) => String(f.value).split('\n'))
    .map((l) => l.match(/^•\s+(.+?)\s+\(read as "(.*)"\)$/))
    .filter(Boolean)
    .map(([, name, readAs]) => ({ name: name.replace(/\\([\\*_~`|>])/g, '$1'), readAs: readAs.replace(/\\([\\*_~`|>])/g, '$1') }));
}
async function loadPost(postRef) {
  const [channelId, messageId] = postRef.split(':');
  const res = await discordGet(`/channels/${channelId}/messages/${messageId}`);
  if (!res.ok) throw new Error(`could not read the attendance post (${res.status})`);
  return res.json();
}
// A tagged name's own part starts with it ("sus" -> 자본丶Suszane).
const latinStart = (name, key) => (nameKey(name).match(/[a-z0-9]+/g) || []).some((part) => part.startsWith(key));
// Growth Rate names containing the typed text (letters and digits only, any
// case: "allen" finds 卍Allen卍), plus a sure match of a near spelling.
async function searchRoster(text) {
  const roster = await loadGrowthRateNames();
  const key = nameKey(text);
  const hits = key ? roster.filter((n) => nameKey(n).includes(key)) : [];
  const [near] = matchToRoster([{ name: text, alternatives: [], color: 'typed', uncertain: false }], roster);
  if (near && near.status !== 'unknown' && near.confident && !hits.includes(near.name)) hits.unshift(near.name);
  // Exact name first, then names starting with it, then the rest (25 fit).
  const rank = (n) => (nameKey(n) === key ? 0 : nameKey(n).startsWith(key) || latinStart(n, key) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 25);
}
// Names picked: add them to the post (edited with the bot's own token --
// this interaction belongs to the private picker, not the post).
async function addPickedMembers({ postRef, names, member, user }) {
  const [channelId, messageId] = postRef.split(':');
  const message = await loadPost(postRef);
  const { boss, wall } = postKill(message);
  if (!boss || !wall) throw new Error('attendance post has no boss/time');
  // Picked "Not sure" names: a person confirmed the scan's guess, so the
  // trainer learns that misreading.
  const training = notSureOn(message).filter((u) => names.includes(u.name) && u.readAs).map((u) => ({ name: u.name, readAs: u.readAs, status: 'corrected' }));
  await addNamesToPost({ message, boss, wall, names, presser: presserName(member, user), training, edit: (p) => editChannelMessage(channelId, messageId, p) });
}
async function editChannelMessage(channelId, messageId, payload) {
  const res = await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_TOKEN}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`could not edit the attendance post (${res.status}): ${await res.text().catch(() => '')}`);
  return res.json().catch(() => null);
}

// Adds members to the kill's record, then rewrites the post: each name goes
// into the Attendees List marked ✔ (confirmed by a person, kept by a
// rescan), out of "Not sure", and its ➕ button goes. Screenshots stay.
async function addNamesToPost({ message, boss, wall, names, presser, training = [], edit }) {
  const saved = await saveAttendanceRecord({ boss, wall, names, loggedBy: presser });
  if (training.length) await recordTraining(saved.id, training);

  const embed0 = message.embeds?.[0] || {};
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const fields = embed0.fields || [];
  const attendeeLines = fields.filter((f) => f.name.startsWith('Attendees List')).flatMap((f) => (f.value === '—' ? [] : String(f.value).split('\n')));
  const listed = new Set(attendeeLines.map((l) => l.replace(/^\d+\.\s+/, '').replace(/\s*✔$/, '').replace(/\\([\\*_~`|>])/g, '$1').toLowerCase()));
  for (const name of names) if (!listed.has(name.toLowerCase())) attendeeLines.push(`${attendeeLines.length + 1}. ${escapeMarkdown(name)}${CONFIRMED_MARK}`);
  const unsureLines = fields.filter((f) => f.name.startsWith(NOT_SURE_TITLE)).flatMap((f) => String(f.value).split('\n'))
    .filter((l) => !names.some((name) => l.startsWith(`• ${escapeMarkdown(name)} (`)));
  const first = fields.findIndex((f) => f.name.startsWith('Attendees List'));
  const rest = fields.filter((f) => !f.name.startsWith('Attendees List') && !f.name.startsWith(NOT_SURE_TITLE));
  const at = first < 0 ? rest.length : first;
  const newFields = [
    ...rest.slice(0, at),
    ...listFields(`Attendees List (${attendeeLines.length})`, attendeeLines),
    ...(unsureLines.length ? listFields(`${NOT_SURE_TITLE} (${unsureLines.length})`, unsureLines) : []),
    ...rest.slice(at),
  ].slice(0, 25);
  const footer = String(embed0.footer?.text || '');
  const embed = {
    color: embed0.color,
    url: embed0.url,
    // The post's heading line, kept (a saved Review's "Saved ✅ ...").
    author: embed0.author?.name ? { name: embed0.author.name } : embed0.title ? { name: embed0.title } : undefined,
    fields: newFields,
    footer: { text: `${footer}${footer.includes(`➕ by ${presser}`) ? '' : ` · ➕ by ${presser}`}`.slice(0, 2048) },
  };
  const attachments = postScreenshots(message);
  const isAddedName = (b) => String(b.custom_id || '').startsWith(ADD_BUTTON_PREFIX) && lower.has(String(parseAddButtonId(b.custom_id).name || '').toLowerCase());
  const components = restoredComponents(message).map((row) => ({ ...row, components: row.components.filter((b) => !isAddedName(b)) })).filter((row) => row.components.length);
  await edit({
    embeds: screenshotEmbeds(embed, attachments.map((a) => a.filename)),
    attachments: attachments.map((a) => ({ id: a.id })),
    components,
  });
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

// A new channel message with files attached (the bot's own token),
// referenced from the embeds as attachment://<filename>.
async function postChannelMessageWithFiles(channelId, payload, files) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.filename })) }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.buffer], { type: f.contentType }), f.filename));
  const res = await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers: { Authorization: `Bot ${DISCORD_TOKEN}` }, body: form });
  if (!res.ok) throw new Error(`Discord rejected the message with screenshots (${res.status}): ${await res.text().catch(() => '')}`);
  return res.json().catch(() => null);
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
        await editOriginalResponse(interaction.application_id, interaction.token, { components: restoredComponents(message) }).catch(() => {});
      })
    );
    return;
  }

  // ➕ pressed on a "Not sure" name: acknowledge at once (the post updates
  // when the save is done), then add them.
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && String(interaction.data?.custom_id || '').startsWith(ADD_BUTTON_PREFIX)) {
    res.json({ type: 6 /* DEFERRED_UPDATE_MESSAGE */ });
    waitUntil(
      confirmUnsureName({
        applicationId: interaction.application_id,
        token: interaction.token,
        message: interaction.message,
        customId: interaction.data.custom_id,
        member: interaction.member,
        user: interaction.user,
      }).catch(async (err) => {
        console.error('attendance ➕ could not add the name:', err);
        await postFollowup(interaction.application_id, interaction.token, { flags: 64, content: 'Could not add that name -- please try again, or add them on the website.' }).catch(() => {});
      })
    );
    return;
  }

  // ➕ Add member on a post, or 🔎 Search again in the picker: the search box.
  const cid = String(interaction.data?.custom_id || '');
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid === ADD_MEMBER_BUTTON_ID) {
    return res.json(searchForm(`${interaction.message.channel_id}:${interaction.message.id}`));
  }
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid.startsWith(ADD_SEARCH_PREFIX)) {
    return res.json(searchForm(cid.slice(ADD_SEARCH_PREFIX.length)));
  }
  // Search sent: the matches underneath, as a dropdown to pick from. The
  // first search (from the post) opens a new private picker; a search from
  // the picker updates it, keeping what was picked before.
  if (interaction.type === 5 /* MODAL_SUBMIT */ && cid.startsWith(ADD_SEARCH_FORM_PREFIX)) {
    const postRef = cid.slice(ADD_SEARCH_FORM_PREFIX.length);
    const fromPost = interaction.message?.id === postRef.split(':')[1];
    res.json(fromPost ? { type: 5 /* DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE */, data: { flags: 64 } } : { type: 6 /* DEFERRED_UPDATE_MESSAGE */ });
    const q = String(interaction.data.components?.[0]?.components?.[0]?.value || '').trim();
    const picked = fromPost ? [] : pickedIn(interaction.message);
    waitUntil(
      searchRoster(q)
        .then((matches) => editOriginalResponse(interaction.application_id, interaction.token, pickerMessage(postRef, matches, { picked, query: q })))
        .catch(async (err) => {
          console.error('attendance member search failed:', err);
          await editOriginalResponse(interaction.application_id, interaction.token, { content: 'Could not search the member list -- please try again.' }).catch(() => {});
        })
    );
    return;
  }
  // Review of a boss-name post: tick/untick, ➕ search, Save, Cancel -- only
  // the poster or an admin.
  const isReviewPart = cid.startsWith(REVIEW_PICK_PREFIX) || cid.startsWith(REVIEW_SAVE_PREFIX) || [REVIEW_ADD_ID, REVIEW_ADD_FORM_ID, REVIEW_CANCEL_ID, REVIEW_LOOT_ID, REVIEW_LOOT_FORM_ID].includes(cid);
  if ((interaction.type === 3 || interaction.type === 5) && isReviewPart) {
    const message = interaction.message;
    const meta = reviewMeta(message);
    if (!mayUseReview(interaction, meta)) {
      return res.json({ type: 4, data: { flags: 64, content: 'Only whoever posted these screenshots, or an admin, can use this review.' } });
    }
    if (cid.startsWith(REVIEW_PICK_PREFIX)) {
      return res.json({ type: 7 /* UPDATE_MESSAGE */, data: updatedReview(message, { changed: { id: cid, values: interaction.data.values || [] } }) });
    }
    if (cid === REVIEW_ADD_ID) {
      return res.json({
        type: 9 /* MODAL */,
        data: {
          custom_id: REVIEW_ADD_FORM_ID,
          title: 'Find who was missed',
          components: [{ type: 1, components: [{ type: 4, custom_id: 'q', style: 1, required: true, min_length: 1, max_length: 40, label: 'Name, or part of it', placeholder: 'e.g. jen' }] }],
        },
      });
    }
    if (cid === REVIEW_ADD_FORM_ID) {
      res.json({ type: 6 /* DEFERRED_UPDATE_MESSAGE */ });
      const q = String(interaction.data.components?.[0]?.components?.[0]?.value || '').trim();
      waitUntil(
        reviewSearchRow(message, q)
          .then(async (row) => {
            if (!row) return postFollowup(interaction.application_id, interaction.token, { flags: 64, content: `No Growth Rate name has "${escapeMarkdown(q)}" (or they're already listed). Try fewer letters.` });
            return editOriginalResponse(interaction.application_id, interaction.token, updatedReview(message, { searchRow: row }));
          })
          .catch((err) => console.error('review search failed:', err))
      );
      return;
    }
    if (cid === REVIEW_LOOT_ID) {
      return res.json({
        type: 9 /* MODAL */,
        data: {
          custom_id: REVIEW_LOOT_FORM_ID,
          title: 'Add the loot list',
          components: [{ type: 1, components: [{
            type: 4, custom_id: 'links', style: 2, required: true, min_length: 10, max_length: 4000,
            label: 'Loot screenshot link(s)',
            // (Discord refuses a placeholder over 100 characters -- the form then never opens.)
            placeholder: 'Post the loot screenshot, right-click it > Copy Link, paste here (one link per line)',
          }] }],
        },
      });
    }
    if (cid === REVIEW_LOOT_FORM_ID) {
      res.json({ type: 6 /* DEFERRED_UPDATE_MESSAGE */ });
      const text = String(interaction.data.components?.[0]?.components?.[0]?.value || '');
      const stopTyping = keepTyping(interaction.channel_id || message.channel_id);
      waitUntil(
        addLootToReview({ applicationId: interaction.application_id, token: interaction.token, message, text })
          .then(async (problem) => {
            if (problem) await postFollowup(interaction.application_id, interaction.token, { flags: 64, content: problem });
          })
          .catch(async (err) => {
            console.error('review add loot failed:', err);
            const why = err instanceof LinkError ? multi('linkFailed', { link: err.link }) : 'Could not read that loot screenshot -- check the link and try again.';
            await postFollowup(interaction.application_id, interaction.token, { flags: 64, content: why }).catch(() => {});
          })
          .finally(stopTyping)
      );
      return;
    }
    if (cid === REVIEW_CANCEL_ID) {
      const presser = presserName(interaction.member, interaction.user);
      res.json({ type: 7, data: { embeds: [{ color: 0x95a5a6, description: `✖️ Cancelled by ${escapeMarkdown(presser)} -- nothing was saved.` }], attachments: [], components: [] } });
      if (meta) waitUntil(setMark(meta.channelId, meta.messageId, MARK_FAILED).catch(() => {}));
      return;
    }
    if (cid.startsWith(REVIEW_SAVE_PREFIX)) {
      const picked = pickedIn(message);
      const saving = updatedReview(message);
      saving.components = [...saving.components.slice(0, -1), reviewButtons(meta, picked.length, true)];
      res.json({ type: 7, data: saving });
      waitUntil(
        saveReview({ applicationId: interaction.application_id, token: interaction.token, message, member: interaction.member, user: interaction.user })
          .catch(async (err) => {
            console.error('review save failed:', err);
            await postFollowup(interaction.application_id, interaction.token, { flags: 64, content: 'Saving failed -- please press Save again.' }).catch(() => {});
            await editOriginalResponse(interaction.application_id, interaction.token, updatedReview(message)).catch(() => {});
          })
      );
      return;
    }
  }
  // A dropdown used: only collects (the picker shows who's picked so far).
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid.startsWith(ADD_PICK_PREFIX)) {
    return res.json({ type: 7 /* UPDATE_MESSAGE */, data: repickedPicker(interaction.message, { id: cid, values: interaction.data.values || [] }) });
  }
  // ➖ Remove on a post: a private list of its attendees to tick.
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid === REMOVE_MEMBER_BUTTON_ID) {
    const postRef = `${interaction.message.channel_id}:${interaction.message.id}`;
    return res.json({ type: 4 /* CHANNEL_MESSAGE_WITH_SOURCE */, data: removerMessage(postRef, attendeesOn(interaction.message)) });
  }
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid.startsWith(RM_PICK_PREFIX)) {
    return res.json({ type: 7 /* UPDATE_MESSAGE */, data: repickedRemover(interaction.message, { id: cid, values: interaction.data.values || [] }) });
  }
  // 🗑️ Remove: everyone ticked, in one go.
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid.startsWith(RM_CONFIRM_PREFIX)) {
    const names = pickedIn(interaction.message);
    if (!names.length) return res.json({ type: 6 /* nothing ticked: no change */ });
    res.json({ type: 7 /* UPDATE_MESSAGE */, data: { content: `Removing ${names.length}: ${names.map(escapeMarkdown).join(', ')}…`, components: [] } });
    waitUntil(
      removePickedMembers({ postRef: cid.slice(RM_CONFIRM_PREFIX.length), names, member: interaction.member, user: interaction.user })
        .then(({ removed }) => editOriginalResponse(interaction.application_id, interaction.token, {
          content: `✅ Removed ${removed.length} from the record: ${(removed.length ? removed : names).map(escapeMarkdown).join(', ')}`, components: [],
        }))
        .catch(async (err) => {
          console.error('attendance Remove failed:', err);
          await editOriginalResponse(interaction.application_id, interaction.token, { content: 'Could not remove them -- please try again, or fix it on the website.', components: [] }).catch(() => {});
        })
    );
    return;
  }
  // ✅ Add: everyone picked, in one go.
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid.startsWith(ADD_CONFIRM_PREFIX)) {
    const names = pickedIn(interaction.message);
    if (!names.length) return res.json({ type: 6 /* nothing picked: no change */ });
    res.json({ type: 7 /* UPDATE_MESSAGE */, data: { content: `Adding ${names.length}: ${names.map(escapeMarkdown).join(', ')}…`, components: [] } });
    waitUntil(
      addPickedMembers({ postRef: cid.slice(ADD_CONFIRM_PREFIX.length), names, member: interaction.member, user: interaction.user })
        .then(() => editOriginalResponse(interaction.application_id, interaction.token, { content: `✅ Added ${names.length} to the post: ${names.map(escapeMarkdown).join(', ')}`, components: [] }))
        .catch(async (err) => {
          console.error('attendance Add member failed:', err);
          await editOriginalResponse(interaction.application_id, interaction.token, { content: 'Could not add them -- please try again, or add them on the website.', components: [] }).catch(() => {});
        })
    );
    return;
  }

  // 🎁 Loot on a saved post: the private loot editor for that kill.
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid === LOOT_BUTTON_ID) {
    const postRef = `${interaction.message.channel_id}:${interaction.message.id}`;
    res.json({ type: 5 /* DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE */, data: { flags: 64 } });
    waitUntil(
      lootKill(postRef)
        .then(({ boss, wall }) => loadKillLoot(boss, wall))
        .then((loot) => editOriginalResponse(interaction.application_id, interaction.token, lootEditorMessage(postRef, loot)))
        .catch(async (err) => {
          console.error('loot editor could not open:', err);
          await editOriginalResponse(interaction.application_id, interaction.token, { content: 'Could not load this kill\'s loot -- please try again, or fix it on the website.' }).catch(() => {});
        })
    );
    return;
  }
  // An item picked in the editor: a form for its new quantity.
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid.startsWith(LOOT_PICK_PREFIX)) {
    const postRef = cid.slice(LOOT_PICK_PREFIX.length);
    const key = interaction.data.values?.[0];
    // The item's name and quantity, from the editor's own dropdown (no
    // database call: a form has to be the answer within Discord's 3 seconds).
    const option = (interaction.message?.components || []).flatMap((r) => r.components || []).flatMap((c) => c.options || []).find((o) => o.value === key);
    if (!option) return res.json({ type: 6 });
    return res.json(lootQuantityForm(postRef, { key, name: option.label, quantity: Number(String(option.description || '').match(/\d+/)?.[0] || 0) }));
  }
  // The new quantity sent.
  if (interaction.type === 5 /* MODAL_SUBMIT */ && cid.startsWith(LOOT_QTY_PREFIX)) {
    const { postRef, tail: key } = parsePostRefTail(cid, LOOT_QTY_PREFIX);
    const quantity = parseQuantity(formValue(interaction, 'qty'));
    if (quantity === null) return res.json({ type: 4, data: { flags: 64, content: `"How many" has to be a whole number from 0 to ${LOOT_MAX_QUANTITY}.` } });
    res.json({ type: 6 /* DEFERRED_UPDATE_MESSAGE */ });
    waitUntil(
      (async () => {
        const { boss, wall } = await lootKill(postRef);
        const item = (await loadKillLoot(boss, wall))?.items.find((i) => i.key === key);
        if (!item) {
          const loot = await loadKillLoot(boss, wall);
          return editOriginalResponse(interaction.application_id, interaction.token, lootEditorMessage(postRef, loot, { status: 'That item changed in the meantime -- here is the loot as it is now.' }));
        }
        return applyLootChange({ applicationId: interaction.application_id, token: interaction.token, postRef, name: item.name, quantity, member: interaction.member, user: interaction.user });
      })().catch(async (err) => {
        console.error('loot quantity change failed:', err);
        await postFollowup(interaction.application_id, interaction.token, { flags: 64, content: 'Could not change that item -- please try again, or fix it on the website.' }).catch(() => {});
      })
    );
    return;
  }
  // ➕ Add item: the name + quantity form.
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid.startsWith(LOOT_ADD_PREFIX)) {
    return res.json(lootAddForm(cid.slice(LOOT_ADD_PREFIX.length)));
  }
  // Name + quantity sent: one known item that fits is added straight away;
  // several (or none) put a "which one?" dropdown on the editor.
  if (interaction.type === 5 /* MODAL_SUBMIT */ && cid.startsWith(LOOT_ADD_FORM_PREFIX)) {
    const postRef = cid.slice(LOOT_ADD_FORM_PREFIX.length);
    const typed = formValue(interaction, 'name').replace(/\s+/g, ' ');
    const quantity = parseQuantity(formValue(interaction, 'qty'));
    if (quantity === null || quantity === 0) return res.json({ type: 4, data: { flags: 64, content: `"How many" has to be a whole number from 1 to ${LOOT_MAX_QUANTITY}.` } });
    res.json({ type: 6 /* DEFERRED_UPDATE_MESSAGE */ });
    waitUntil(
      (async () => {
        const { boss, wall } = await lootKill(postRef);
        const matches = await findLootItems(typed, boss);
        if (matches.length === 1) {
          return applyLootChange({ applicationId: interaction.application_id, token: interaction.token, postRef, name: matches[0], quantity, member: interaction.member, user: interaction.user, add: true });
        }
        const loot = await loadKillLoot(boss, wall);
        const status = matches.length
          ? `${matches.length > 24 ? 'Many' : matches.length} items have "${escapeMarkdown(typed)}" -- pick the one that dropped${matches.length > 24 ? ' (or ➕ Add item again with more of the name)' : ''}:`
          : `No item the site knows has "${escapeMarkdown(typed)}". Check the spelling, or pick 🆕 to save it as typed:`;
        return editOriginalResponse(interaction.application_id, interaction.token, lootEditorMessage(postRef, loot, { status, choose: lootChooseRow(postRef, typed, quantity, matches) }));
      })().catch(async (err) => {
        console.error('loot add failed:', err);
        await postFollowup(interaction.application_id, interaction.token, { flags: 64, content: 'Could not add that item -- please try again, or add it on the website.' }).catch(() => {});
      })
    );
    return;
  }
  // The item meant, picked from the "which one?" dropdown.
  if (interaction.type === 3 /* MESSAGE_COMPONENT */ && cid.startsWith(LOOT_CHOOSE_PREFIX)) {
    const { postRef, tail } = parsePostRefTail(cid, LOOT_CHOOSE_PREFIX);
    const quantity = Number(tail);
    const picked = String(interaction.data.values?.[0] || '');
    const name = picked.slice(1).trim();
    if (!name || !(quantity > 0)) return res.json({ type: 6 });
    res.json({ type: 6 /* DEFERRED_UPDATE_MESSAGE */ });
    waitUntil(
      applyLootChange({ applicationId: interaction.application_id, token: interaction.token, postRef, name, quantity, member: interaction.member, user: interaction.user, add: true })
        .catch(async (err) => {
          console.error('loot add (picked) failed:', err);
          await postFollowup(interaction.application_id, interaction.token, { flags: 64, content: 'Could not add that item -- please try again, or add it on the website.' }).catch(() => {});
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

// ─── Boss-name posts: read, then Review → Save ──────────────────────────
// A member posts screenshots in the attendance channel with the boss's name
// ("Ducas", "dergio 88/96"). The bot reads them -- on the officer's PC when
// its bot is running (discord-bot/index.js), or later from the website's
// "Sync from Discord" -- and replies with a Review: nothing is saved yet.
// The names it's sure of are ticked, "not sure" guesses are listed
// unticked, ➕ finds anyone missed; Save logs the ticked names (and the
// loot, when a loot-list screenshot was in the post) and turns the Review
// into the record, with ➕ Add member / ➖ Remove for later fixes. Cancel
// drops it. Only the poster or an admin can use the buttons.
//
// Everything the Review needs lives in the Review message itself (the
// dropdowns' ticked options, the Boss / Time of Death / Loots fields, the
// poster and the original post in the Save button's id), so its buttons
// work from the website whether or not the PC is on -- nothing is stored
// anywhere else until Save.
//
// The member's post is marked: 🔍 while reading, 📝 once its Review is up,
// ✅ saved, ❌ cancelled or unreadable. Sync reads the posts with none of
// these yet.
const REVIEW_PICK_PREFIX = 'attendance:rpick:';
const REVIEW_SEARCH_ROW_ID = 'attendance:rpick:search';
const REVIEW_SAVE_PREFIX = 'attendance:rsave:';
const REVIEW_ADD_ID = 'attendance:radd';
const REVIEW_ADD_FORM_ID = 'attendance:raddform';
const REVIEW_CANCEL_ID = 'attendance:rcancel';
const REVIEW_LOOT_ID = 'attendance:rloot';
const REVIEW_LOOT_FORM_ID = 'attendance:rlootform';
const MARK_READING = '🔍', MARK_REVIEW = '📝', MARK_SAVED = '✅', MARK_FAILED = '❌';
const NOT_SURE_PREFIX = 'not sure · read as ';

async function setMark(channelId, messageId, emoji) {
  for (const old of [MARK_READING, MARK_REVIEW, MARK_SAVED, MARK_FAILED]) if (old !== emoji) await removeOwnReaction(channelId, messageId, old);
  await addReaction(channelId, messageId, emoji);
}

/**
 * Reads one boss-name post and replies with its Review.
 * @returns {Promise<string>} what happened, for logs and the Sync summary
 */
async function reviewAttendancePost({ channelId, messageId, content, imageUrls, authorId, authorName, onStatus = null }) {
  if (!isAttendanceChannel(channelId)) return 'skipped: not the attendance channel';
  if (!imageUrls?.length && !hasScreenshotLinks(content)) return 'skipped: no screenshots';
  const boss = findBossInText(content);
  if (!boss) return 'skipped: no boss name';

  await setMark(channelId, messageId, MARK_READING);
  // "Sovereign Records is typing…" in the channel the whole time it reads,
  // so it's clear it's working (Discord shows it ~10 s per call).
  const stopTyping = keepTyping(channelId);
  const reply = (payload) => postChannelMessage(channelId, { ...payload, message_reference: { message_id: messageId, fail_if_not_exists: false }, allowed_mentions: { parse: [] } });
  const progress = await startProgress(channelId, messageId, boss, onStatus);
  try {
    // Screenshots attached, and/or linked in the text: Discord image links
    // (media.discordapp.net / cdn.discordapp.com, fresh copies fetched since
    // they expire) or links to messages that have them -- same as
    // /attendance's link option.
    const linked = hasScreenshotLinks(content) ? (await imagesFromLinks(content)).map((a) => a.url) : [];
    await progress.step('downloading the screenshots', 0.03);
    let buffers = await downloadScreenshots([...(imageUrls || []), ...linked].slice(0, 10));
    const duplicates = await findDuplicateShots(buffers);
    buffers = buffers.filter((_, i) => !duplicates.has(i));
    const { lootRows, nameLists, lootCheck } = await splitLootScreenshots(buffers, { onShot: (i, n) => progress.step(`screenshot ${i + 1} of ${n}`, 0.1 + (0.75 * i) / n) });
    await progress.step(`matching names${buffers.length ? " and loot" : ""}`, 0.88);
    const lootGroups = lootRows.length
      ? buildLootGroups(lootRows, await loadKnownItems().catch(() => []), await loadLearnedItems().catch(() => new Map()), await loadIconLibrary().catch(() => new Map()))
      : [];
    // Time of Death: the loot list's own kill time when it's this boss's;
    // otherwise when the post was made.
    const kill = lootGroups.find((g) => g.boss.boss === boss.boss);
    const when = kill ? { wall: kill.wall, unix: wallToUnix(kill.wall) } : resolveEventTime(new Date(snowflakeTime(messageId)));
    const scan = nameLists.length ? await scanNameScreenshots(nameLists) : { savable: [], unsure: [] };
    const sure = scan.savable || [];
    const unsure = (scan.unsure || []).filter((u) => !sure.includes(u.name));
    if (!sure.length && !unsure.length && !kill) {
      await setMark(channelId, messageId, MARK_FAILED);
      await reply({ content: multi('noNames') });
      return 'no names read';
    }
    const otherLoot = lootGroups.filter((g) => g !== kill).map((g) => g.boss.boss);
    // This kill already saved (the same screenshots posted again, or more
    // of the same fight): the Review updates that record. Its saved names
    // are listed ticked along with the new reading -- Save keeps exactly the
    // ticked ones -- and a loot list here replaces its saved loot.
    const saved = await loadKillRecord(boss, when.wall).catch(() => null);
    const savedOnly = saved ? saved.names.filter((n) => !sure.some((s) => s.toLowerCase() === n.toLowerCase())) : [];
    const review = reviewMessage({
      boss, when: saved ? { wall: saved.wall, unix: wallToUnix(saved.wall) } : when, sure, unsure, kill, saved, savedOnly, lootCheck,
      notes: [
        `${buffers.length} screenshot${buffers.length === 1 ? '' : 's'} read${duplicates.size ? ` (${duplicates.size} duplicate skipped)` : ''}`,
        kill ? 'Time of Death from the loot list' : 'Time of Death = when this was posted (no loot list)',
        lootCheck?.ok && lootCheck.text,
        kill?.items.some((i) => i.iconRows) && `${kill.items.reduce((n, i) => n + (i.iconRows || 0), 0)} loot named by its icon (name unreadable) -- check it`,
        otherLoot.length && `loot of another boss ignored (${[...new Set(otherLoot)].join(', ')})`,
      ].filter(Boolean),
      authorId, authorName, channelId, messageId,
    });
    // The screenshots go up with the Review, so whoever checks it sees them
    // right there (re-uploaded: Discord's links to the original expire).
    // Too big or refused: the Review is posted without them.
    await progress.step("posting the Review", 0.96);
    const files = await screenshotsForPost(buffers).catch(() => []);
    const withShots = { ...review, embeds: screenshotEmbeds(review.embeds[0], files.map((f) => f.filename)) };
    const ref = { message_reference: { message_id: messageId, fail_if_not_exists: false }, allowed_mentions: { parse: [] } };
    const posted = files.length ? await postChannelMessageWithFiles(channelId, { ...withShots, ...ref }, files).catch((err) => (console.error('review screenshots not attached:', err.message), null)) : null;
    if (!posted) await reply(review);
    await setMark(channelId, messageId, MARK_REVIEW);
    return `review posted: ${sure.length} sure, ${unsure.length} not sure${kill ? `, ${kill.items.length} loot rows` : ''}`;
  } catch (err) {
    console.error('attendance review failed:', err);
    await setMark(channelId, messageId, MARK_FAILED);
    const why = err instanceof LinkError ? multi('linkFailed', { link: err.link }) : multi(err instanceof AttendanceScanError ? err.key : 'readFailed');
    await reply({ content: why }).catch(() => {});
    return `failed: ${err.message}`;
  } finally {
    stopTyping();
    await progress.done();
  }
}
// A progress message under the post while it's read ("⏳ Reading Ducas ·
// screenshot 2 of 4" and a bar), edited at each step and deleted once the
// Review (or an error reply) is up. Best-effort: if Discord refuses, the
// reading goes on without it.
const PROGRESS_SLOTS = 10;
function progressText(boss, label, fraction) {
  const filled = Math.max(0, Math.min(PROGRESS_SLOTS, Math.round(fraction * PROGRESS_SLOTS)));
  return `⏳ Reading **${escapeMarkdown(boss.boss)}** · ${label}\n${'▰'.repeat(filled)}${'▱'.repeat(PROGRESS_SLOTS - filled)} ${Math.round(fraction * 100)}%`;
}
// onStatus(boss, label, fraction): each step also goes to whoever runs the
// reading (the PC bot shows it as its Discord status and in its window);
// onStatus(null) when done.
async function startProgress(channelId, messageId, boss, onStatus = null) {
  const tell = (label, fraction) => { try { onStatus?.(boss, label, fraction); } catch { /* status only */ } };
  tell('starting', 0);
  const msg = await postChannelMessage(channelId, {
    content: progressText(boss, 'starting', 0),
    message_reference: { message_id: messageId, fail_if_not_exists: false },
    allowed_mentions: { parse: [] },
  }).catch((err) => (console.error('progress message not posted:', err.message), null));
  return {
    async step(label, fraction) {
      tell(label, fraction);
      if (!msg?.id) return;
      await editChannelMessage(channelId, msg.id, { content: progressText(boss, label, fraction) }).catch(() => {});
    },
    async done() {
      tell(null, 1);
      if (!msg?.id) return;
      await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages/${msg.id}`, { method: 'DELETE', headers: { Authorization: `Bot ${DISCORD_TOKEN}` } }).catch(() => {});
    },
  };
}
function keepTyping(channelId) {
  const ping = () => fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/typing`, { method: 'POST', headers: { Authorization: `Bot ${DISCORD_TOKEN}` } }).catch(() => {});
  ping();
  const timer = setInterval(ping, 8000);
  return () => clearInterval(timer);
}

function reviewTitle(boss, n) {
  return `Review · ${bossTitle(boss)} · ${n} to log`;
}
function reviewMessage({ boss, when, sure, unsure, kill, saved = null, savedOnly = [], lootCheck = null, notes, authorId, authorName, channelId, messageId }) {
  const lootLines = kill ? kill.items.map((i) => `${escapeMarkdown(i.matched ? i.name : i.fragment)} ×${i.quantity}${i.matched ? '' : ' ❓'}`) : [];
  const page = boss.schedule === 'world_boss' ? 'worldboss' : boss.schedule;
  const ticked = sure.length + savedOnly.length;
  const embed = {
    color: 0xf1c40f,
    url: `${SITE_URL}/#${page}`, // also groups the screenshots into one gallery
    author: { name: reviewTitle(boss, ticked) }, // a heading, not a link (a title would link to the site)
    description: reviewDescription(saved, Boolean(kill)),
    fields: [
      { name: 'Boss', value: escapeMarkdown(boss.boss), inline: true },
      { name: 'Time of Death', value: `<t:${when.unix}:F>`, inline: true },
      ...(kill ? listFields(`Loots (${kill.items.reduce((s, i) => s + i.quantity, 0)})`, lootLines) : []),
      ...(lootCheck && !lootCheck.ok ? [{ name: LOOT_CHECK_TITLE, value: lootCheck.text }] : []),
    ].slice(0, 25),
    footer: { text: [...notes, `posted by ${authorName}`, `only ${authorName} or an admin can use these buttons`].join(' · ').slice(0, 2048) },
  };
  const options = [
    ...sure.map((n) => ({ label: n.slice(0, 100), value: n.slice(0, 100), default: true })),
    ...savedOnly.map((n) => ({ label: n.slice(0, 100), value: n.slice(0, 100), default: true, description: 'already saved (not read this time)' })),
    ...unsure.filter((u) => !savedOnly.includes(u.name)).map((u) => ({ label: u.name.slice(0, 100), value: u.name.slice(0, 100), default: false, description: `${NOT_SURE_PREFIX}${u.readAs || '?'}`.slice(0, 100) })),
  ];
  const selects = [];
  for (let i = 0; i < options.length && selects.length < 3; i += 25) {
    const chunk = options.slice(i, i + 25);
    selects.push({ type: 1, components: [{
      type: 3, custom_id: `${REVIEW_PICK_PREFIX}${selects.length}`,
      placeholder: options.length > 25 ? `Attendees (${i + 1}-${i + chunk.length})` : 'Attendees -- untick anyone who wasn\'t there',
      min_values: 0, max_values: chunk.length, options: chunk,
    }] });
  }
  return { embeds: [embed], components: [...selects, reviewButtons({ authorId, channelId, messageId, update: Boolean(saved) }, ticked)] };
}
function reviewDescription(saved, hasLoot) {
  if (!saved) {
    return [
      '**Nothing is saved yet.**',
      'Untick anyone who wasn\'t there, tick anyone under *not sure* who was, ➕ add anyone missed, 🎁 add the loot list if it\'s missing -- then press **Save**.',
    ].join('\n');
  }
  const lootPlan = !hasLoot ? 'keeps the saved loot' : saved.lootHasSales ? 'keeps the saved loot (it has prices/sales -- fix it on the site)' : 'replaces the saved loot with this loot list';
  return [
    `**Already on the site** -- this kill was saved before (${saved.names.length} names, ${saved.loot.reduce((s, l) => s + l.quantity, 0)} loot). Nothing changes yet.`,
    `**Update** keeps exactly the names ticked below (saved ones included) and ${lootPlan}.`,
  ].join('\n');
}
function reviewButtons({ authorId, channelId, messageId, update = false }, picked, disabled = false) {
  return { type: 1, components: [
    { type: 2, style: 3, custom_id: `${REVIEW_SAVE_PREFIX}${authorId}:${channelId}:${messageId}${update ? ':u' : ''}`, label: disabled ? 'Saving…' : `${update ? 'Update' : 'Save'} (${picked})`, disabled: disabled || false },
    { type: 2, style: 2, custom_id: REVIEW_LOOT_ID, label: '🎁 Add loot', disabled },
    { type: 2, style: 1, custom_id: REVIEW_ADD_ID, label: '➕ Add a missed member', disabled },
    { type: 2, style: 2, custom_id: REVIEW_CANCEL_ID, label: 'Cancel', disabled },
  ] };
}
// The poster and their post, from the Review's Save button.
function reviewMeta(message) {
  for (const row of message?.components || []) {
    for (const c of row.components || []) {
      if (String(c.custom_id || '').startsWith(REVIEW_SAVE_PREFIX)) {
        const [authorId, channelId, messageId, mode] = c.custom_id.slice(REVIEW_SAVE_PREFIX.length).split(':');
        return { authorId, channelId, messageId, update: mode === 'u' };
      }
    }
  }
  return null;
}
// The poster, or anyone who can manage the server or its messages.
function mayUseReview(interaction, meta) {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  if (meta && userId === meta.authorId) return true;
  const perms = BigInt(interaction.member?.permissions || '0');
  return (perms & 0x8n) !== 0n || (perms & 0x20n) !== 0n || (perms & 0x2000n) !== 0n; // Administrator, Manage Server, Manage Messages
}
// The Review again, with ticks (and optionally a fresh search row) updated.
function updatedReview(message, { changed = null, searchRow = undefined } = {}) {
  const meta = reviewMeta(message);
  const picked = pickedIn(message, changed);
  const rows = [];
  for (const row of message.components || []) {
    const c = row.components?.[0];
    if (c?.type !== 3) continue;
    if (c.custom_id === REVIEW_SEARCH_ROW_ID && searchRow !== undefined) continue; // replaced below
    rows.push({ type: 1, components: [{
      type: 3, custom_id: c.custom_id, placeholder: c.placeholder, min_values: 0, max_values: c.max_values,
      options: (c.options || []).map((o) => ({ label: o.label, value: o.value, default: picked.includes(o.value), ...(o.description ? { description: o.description } : {}) })),
    }] });
  }
  if (searchRow) rows.push(searchRow);
  const boss = findBossInText(String(message.embeds?.[0]?.fields?.find((f) => f.name === 'Boss')?.value || ''));
  const old = message.embeds?.[0];
  const embed = { ...cleanEmbed(old), author: { name: boss ? reviewTitle(boss, picked.length) : old?.author?.name || old?.title || "Review" } };
  // The screenshots stay on the Review as they are.
  const shots = postScreenshots(message);
  return { embeds: screenshotEmbeds(embed, shots.map((a) => a.filename)), attachments: shots.map((a) => ({ id: a.id })), components: [...rows, reviewButtons(meta, picked.length)] };
}
function cleanEmbed(e = {}) {
  return {
    // (No title: an embed with a url makes its title a link. The heading is
    // the author line instead.)
    color: e.color, description: e.description, url: e.url,
    author: e.author?.name ? { name: e.author.name } : e.title ? { name: e.title } : undefined,
    fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value, inline: f.inline })),
    footer: e.footer?.text ? { text: e.footer.text } : undefined,
  };
}
// ➕ in a Review: the matches for what was typed, as an extra dropdown
// (already-listed names left out; ticked ones from earlier searches kept).
async function reviewSearchRow(message, q) {
  const listed = new Set();
  let keep = [];
  for (const row of message.components || []) {
    const c = row.components?.[0];
    if (c?.type !== 3) continue;
    if (c.custom_id === REVIEW_SEARCH_ROW_ID) keep = (c.options || []).filter((o) => o.default);
    else for (const o of c.options || []) listed.add(o.value);
  }
  const found = (await searchRoster(q)).filter((n) => !listed.has(n));
  const options = [...keep, ...found.filter((n) => !keep.some((k) => k.value === n)).map((n) => ({ label: n.slice(0, 100), value: n.slice(0, 100), default: false }))].slice(0, 25);
  if (!options.length) return null;
  return { type: 1, components: [{
    type: 3, custom_id: REVIEW_SEARCH_ROW_ID, placeholder: found.length ? `Search "${q}" -- tick who was there`.slice(0, 150) : `Nothing new for "${q}"`.slice(0, 150),
    min_values: 0, max_values: options.length, options,
  }] };
}

// Save: logs the ticked names (and the loot), then the Review becomes the
// record -- same layout as an /attendance post, so ➕ Add member and
// ➖ Remove work on it.
async function saveReview({ applicationId, token, message, member, user }) {
  const meta = reviewMeta(message);
  const { boss, wall } = postKill(message);
  if (!boss || !wall) throw new Error('review has no boss/time');
  const names = pickedIn(message);
  const presser = presserName(member, user);
  const notes = [];
  // Loot: the Review's own list -- items it named (❓ ones aren't saved).
  const fields = message.embeds?.[0]?.fields || [];
  const items = fields.filter((f) => f.name.startsWith('Loots')).flatMap((f) => String(f.value).split('\n'))
    .map((l) => l.match(/^(.+?) ×(\d+)$/)).filter(Boolean)
    .map(([, name, q]) => ({ name: name.replace(/\\([\\*_~`|>])/g, '$1'), quantity: Number(q) }));
  // "Not sure" names someone ticked: the trainer learns those misreadings.
  const training = [];
  for (const row of message.components || []) for (const o of row.components?.[0]?.options || []) {
    if (names.includes(o.value) && String(o.description || '').startsWith(NOT_SURE_PREFIX)) training.push({ name: o.value, readAs: o.description.slice(NOT_SURE_PREFIX.length), status: 'corrected' });
  }
  if (meta?.update) {
    // This kill was already saved: its names become exactly the ticked
    // ones, and a loot list here replaces its loot (unless it has prices or
    // sales on the site).
    const r = await replaceAttendanceRecord({ boss, wall, names, items, loggedBy: presser });
    if (training.length) await recordTraining(r.id, training);
    if (r.lootKept) notes.push('loot kept: it has prices/sales on the site, fix it there');
  } else if (names.length) {
    const saved = await saveAttendanceRecord({ boss, wall, names, loggedBy: presser });
    if (training.length) await recordTraining(saved.id, training);
  }
  if (items.length && !meta?.update) {
    try {
      const saved = await saveLootToRecord({ boss, wall, items, loggedBy: presser });
      if (saved.added === 0) notes.push('loot was already on the site, not added again');
    } catch (err) {
      console.error('review loot could not be saved:', err);
      notes.push('⚠️ loot not saved to the website');
    }
  }
  const page = boss.schedule === 'world_boss' ? 'worldboss' : boss.schedule;
  const embed = {
    color: 0x2ecc71,
    author: { name: `${meta?.update ? 'Updated' : 'Saved'} ✅ ${names.length} name${names.length === 1 ? '' : 's'} ${meta?.update ? 'on' : 'logged to'} ${bossTitle(boss)}` },
    url: `${SITE_URL}/#${page}`,
    fields: [
      fields.find((f) => f.name === 'Boss'),
      fields.find((f) => f.name === 'Time of Death'),
      ...listFields(`Attendees List (${names.length})`, names.map((n, i) => `${i + 1}. ${escapeMarkdown(n)}`)),
      ...fields.filter((f) => f.name.startsWith('Loots')),
    ].filter(Boolean).map((f) => ({ name: f.name, value: f.value, inline: f.inline })).slice(0, 25),
    footer: { text: [...notes, `saved by ${presser}`].join(' · ') },
  };
  const shots = postScreenshots(message); // kept on the record post
  await editOriginalResponse(applicationId, token, {
    embeds: screenshotEmbeds(embed, shots.map((a) => a.filename)),
    attachments: shots.map((a) => ({ id: a.id })),
    components: [{ type: 1, components: [
      { type: 2, style: 2, custom_id: ADD_MEMBER_BUTTON_ID, label: '➕ Add member' },
      { type: 2, style: 2, custom_id: REMOVE_MEMBER_BUTTON_ID, label: '➖ Remove' },
      lootButton(),
    ] }],
  });
  if (meta) await setMark(meta.channelId, meta.messageId, MARK_SAVED);
}

// 🎁 Add loot on a Review (the loot list was left out of the post): reads
// the loot screenshot(s) linked in the form and puts that boss's loot on
// the Review, with the loot list's own kill time as Time of Death. If that
// kill is already on the site, the Review becomes an Update of it (its
// saved names listed ticked). Returns an error text for the presser, or null.
async function addLootToReview({ applicationId, token, message, text }) {
  const { boss } = postKill(message);
  if (!boss) return 'This review has no boss.';
  const urls = hasScreenshotLinks(text) ? (await imagesFromLinks(text)).map((a) => a.url).slice(0, 10) : [];
  if (!urls.length) return 'No screenshot link found. Post the loot screenshot in the channel, right-click it → Copy Link, and paste that link.';
  const lists = [];
  for (const buffer of await downloadScreenshots(urls)) {
    const rows = await readLootList(buffer).catch(() => null);
    if (rows) lists.push(rows);
  }
  if (!lists.length) return 'That screenshot isn\'t a loot list (no item rows with a kill time on it).';
  const merged = mergeLootScreenshots(lists);
  const check = lootRowCheck(merged.length, lists);
  const groups = buildLootGroups(
    merged,
    await loadKnownItems().catch(() => []), await loadLearnedItems().catch(() => new Map()), await loadIconLibrary().catch(() => new Map())
  );
  const kill = groups.find((g) => g.boss.boss === boss.boss);
  if (!kill) return `That loot list is for ${[...new Set(groups.map((g) => g.boss.boss))].join(', ')}, not ${boss.boss}.`;

  const unix = wallToUnix(kill.wall);
  const saved = await loadKillRecord(boss, kill.wall).catch(() => null);
  const e = cleanEmbed(message.embeds?.[0]);
  const lootLines = kill.items.map((i) => `${escapeMarkdown(i.matched ? i.name : i.fragment)} ×${i.quantity}${i.matched ? '' : ' ❓'}`);
  e.fields = [
    (e.fields || []).find((f) => f.name === 'Boss'),
    { name: 'Time of Death', value: `<t:${saved ? wallToUnix(saved.wall) : unix}:F>`, inline: true },
    ...listFields(`Loots (${kill.items.reduce((s, i) => s + i.quantity, 0)})`, lootLines),
    ...(check && !check.ok ? [{ name: LOOT_CHECK_TITLE, value: check.text }] : []),
  ].filter(Boolean);
  e.description = reviewDescription(saved, true);
  e.footer = { text: String(e.footer?.text || '').replace(/ · ✅ all \d+ loot rows read \(Stored Quantity \d+\)/, '').replace(/Time of Death = when this was posted \(no loot list\)|Time of Death from the loot list/, `Time of Death and loot from the added loot list${check?.ok ? ` · ${check.text}` : ''}`) };

  // Already saved: its names join the list, ticked, and Save becomes Update.
  const components = (message.components || []).map((row) => ({ ...row, components: (row.components || []).map((c) => ({ ...c, options: c.options ? c.options.map((o) => ({ ...o })) : undefined })) }));
  if (saved) {
    const listed = new Set(components.flatMap((r) => r.components.flatMap((c) => (c.options || []).map((o) => o.value.toLowerCase()))));
    const extra = saved.names.filter((n) => !listed.has(n.toLowerCase())).map((n) => ({ label: n.slice(0, 100), value: n.slice(0, 100), default: true, description: 'already saved (not read this time)' }));
    for (const row of components) {
      const c = row.components[0];
      if (c?.type !== 3 || c.custom_id === REVIEW_SEARCH_ROW_ID) continue;
      while (extra.length && c.options.length < 25) c.options.push(extra.shift());
      c.max_values = c.options.length;
    }
    const nameRows = components.filter((r) => r.components[0]?.type === 3 && r.components[0].custom_id !== REVIEW_SEARCH_ROW_ID).length;
    if (extra.length && nameRows < 3) {
      const chunk = extra.splice(0, 25);
      components.unshift({ type: 1, components: [{ type: 3, custom_id: `${REVIEW_PICK_PREFIX}${nameRows}`, placeholder: 'Already saved', min_values: 0, max_values: chunk.length, options: chunk }] });
    }
    for (const row of components) for (const c of row.components) {
      if (String(c.custom_id || '').startsWith(REVIEW_SAVE_PREFIX) && !c.custom_id.endsWith(':u')) c.custom_id += ':u';
    }
  }
  await editOriginalResponse(applicationId, token, updatedReview({ ...message, embeds: [e, ...(message.embeds || []).slice(1)], components }));
  return null;
}

// Website "Sync from Discord": every boss-name post with screenshots in
// the attendance channel from one month (guild clock) that the bot hasn't
// marked yet -- posted while the PC was off -- gets read and its Review
// posted, oldest first, until the time budget runs out (the page calls
// again for the rest). A 🔍 left over from a crash counts as unread after
// 10 minutes.
const SYNC_STALE_READING_MS = 10 * 60 * 1000;
async function syncAttendanceFromDiscord({ month, budgetMs = 200000, onStatus = null }) {
  const started = Date.now();
  const [y, m] = String(month).split('-').map(Number);
  if (!y || !m) throw new Error('month must be YYYY-MM');
  const from = wallToUnix(`${y}-${String(m).padStart(2, '0')}-01T00:00`) * 1000;
  const to = wallToUnix(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00`) * 1000;
  const toSnowflake = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);
  const pending = [];
  for (const channelId of ATTENDANCE_CHANNEL_IDS) {
    let after = toSnowflake(from - 1);
    for (let page = 0; page < 50; page++) {
      const res = await discordGet(`/channels/${channelId}/messages?limit=100&after=${after}`);
      if (!res.ok) throw new Error(`could not read the attendance channel (${res.status})`);
      const batch = await res.json();
      if (!batch.length) break;
      for (const msg of batch) {
        const at = snowflakeTime(msg.id);
        if (at >= to || msg.author?.bot) continue;
        // A forwarded message carries the original (text and screenshots) in
        // message_snapshots; the forward itself is usually empty.
        const parts = [msg, ...(msg.message_snapshots || []).map((snap) => snap.message || {})];
        const text = parts.map((m) => m.content || '').filter(Boolean).join('\n');
        const images = parts.flatMap((m) => m.attachments || []).filter((a) => (a.content_type || '').startsWith('image/') || IMAGE_FILE.test(a.filename || ''));
        if ((!images.length && !hasScreenshotLinks(text)) || !findBossInText(text)) continue;
        const mine = new Set((msg.reactions || []).filter((r) => r.me).map((r) => r.emoji?.name));
        if (mine.has(MARK_REVIEW) || mine.has(MARK_SAVED) || mine.has(MARK_FAILED)) continue;
        if (mine.has(MARK_READING) && Date.now() - at < SYNC_STALE_READING_MS) continue;
        pending.push({ channelId, msg, images, text });
      }
      // Pages come newest first; continue after the newest one seen.
      after = batch.reduce((max, x) => (BigInt(x.id) > BigInt(max) ? x.id : max), after);
      if (snowflakeTime(after) >= to) break;
    }
  }
  pending.sort((a, b) => (BigInt(a.msg.id) < BigInt(b.msg.id) ? -1 : 1));
  const results = [];
  for (const { channelId, msg, images, text } of pending) {
    if (Date.now() - started > budgetMs) break;
    const outcome = await reviewAttendancePost({
      onStatus,
      channelId, messageId: msg.id, content: text, imageUrls: images.slice(0, 10).map((a) => a.url),
      authorId: msg.author?.id, authorName: msg.member?.nick || msg.author?.global_name || msg.author?.username || 'someone',
    });
    results.push({ messageId: msg.id, boss: findBossInText(text)?.boss, outcome });
  }
  return { found: pending.length, read: results.length, remaining: pending.length - results.length, results };
}

module.exports = { handleDiscordInteraction, postChannelMessage, restickGrowthGuide, processAttendanceMessage, reviewAttendancePost, syncAttendanceFromDiscord };
