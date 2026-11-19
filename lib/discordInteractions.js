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
const { sql } = require('./db');
const { GROWTH_GUIDE, GROWTH_GUIDE_TITLE, GROWTH_GUIDE_CHANNEL_ID } = require('../discord-bot/growthGuide');
const { readNamesFromScreenshot, mergeNameLists } = require('./attendanceOcr');
const { matchToRoster } = require('./rosterMatch');
const { findBossInText, bossTitle, SCANNABLE_BOSSES } = require('./bosses');
const { resolveEventTime, saveAttendanceRecord, wallToUnix } = require('./attendanceRecords');
const { multi, forLocale } = require('./attendanceText');

// /attendance only answers in the boss-attendance channel, so the name
// lists all land in one place.
const ATTENDANCE_CHANNEL_ID = process.env.ATTENDANCE_CHANNEL_ID || '1573000319837806622';
// Kept in sync with register-commands.js's /attendance screenshot options.
const ATTENDANCE_SCREENSHOT_OPTIONS = ['screenshot', 'screenshot2', 'screenshot3', 'screenshot4'];

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

// Every IGN on the Growth Rate page -- what /attendance corrects OCR
// readings against.
async function loadGrowthRateNames() {
  const { rows } = await sql`
    SELECT DISTINCT ON (LOWER(TRIM(ign))) TRIM(ign) AS name FROM growth_submissions
    WHERE TRIM(ign) <> ''
    ORDER BY LOWER(TRIM(ign))
  `;
  return rows.map((r) => r.name);
}

// Thrown by scanAttendanceScreenshots; `key` names the member-facing text
// in lib/attendanceText.js, `cause` keeps the technical reason for the logs.
class AttendanceScanError extends Error {
  constructor(key, cause) {
    super(`${key}: ${cause?.message || cause}`);
    this.key = key;
  }
}


// Downloads the screenshots, reads the blue/green/light-green nameplates
// off them and matches the names to the Growth Rate list. Shared by
// /attendance and the automatic scan of members' own screenshot posts.
// Nothing is saved yet -- website logging comes later.
async function scanAttendanceScreenshots(imageUrls) {
  let screenshots;
  try {
    screenshots = await Promise.all(
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

  // One at a time: the OCR readers are shared and process one image each
  // anyway, and each screenshot only takes about a second.
  const perScreenshot = [];
  try {
    for (const buffer of screenshots) perScreenshot.push(await readNamesFromScreenshot(buffer));
  } catch (err) {
    console.error('attendance name reading failed:', err);
    throw new AttendanceScanError('readFailed', err);
  }

  // Snap each reading onto the Growth Rate list's spelling. If that list
  // can't be loaded, still post the raw OCR names rather than nothing.
  const readings = mergeNameLists(perScreenshot);
  const roster = await loadGrowthRateNames().catch((err) => {
    console.error('/attendance could not load the Growth Rate names:', err);
    return null;
  });
  // Each entry: the name plus its mark (⚠️ guess / ❓ not on the list).
  let entries, legend;
  if (roster) {
    // Every sighting from every screenshot, each with all its OCR readings.
    const names = matchToRoster(perScreenshot.flat(), roster);
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
  const savable = roster ? matchToRoster(perScreenshot.flat(), roster).filter((n) => n.status !== 'unknown').map((n) => n.name) : [];
  const hasUnknown = roster ? entries.some((e) => e.endsWith(' ❓')) : false;
  return { entries, legend, fullList, countText, savable, hasUnknown };
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

// /attendance: read the screenshots attached to the command, save the
// attendees on the site, post a short summary, and list them in a thread.
async function processAttendance({ applicationId, token, options, resolved, member, user }) {
  const getOpt = (name) => options.find((o) => o.name === name)?.value;
  const bossText = String(getOpt('boss') || '').trim();
  const submitterName = member?.nick || member?.user?.global_name || member?.user?.username || user?.global_name || user?.username;
  const attachments = ATTENDANCE_SCREENSHOT_OPTIONS.map((name) => resolved?.attachments?.[getOpt(name)]).filter(Boolean);

  const failWith = (description) => editOriginalResponse(applicationId, token, { embeds: [{ color: 0xe74c3c, description }] });

  const boss = findBossInText(bossText);
  if (!boss) return void (await failWith(unknownBossText(bossText)));
  const when = resolveEventTime({ date: getOpt('date'), time: getOpt('time') });
  if (when.error) return void (await failWith(multi(when.error, { value: escapeMarkdown(getOpt(when.error === 'badDate' ? 'date' : 'time')) })));
  if (!attachments.length || attachments.some((a) => !(a.content_type || '').startsWith('image/'))) {
    return void (await failWith(multi('invalidAttachment')));
  }

  let scan;
  try {
    scan = await scanAttendanceScreenshots(attachments.map((a) => a.url));
  } catch (err) {
    if (!(err instanceof AttendanceScanError)) throw err;
    return void (await failWith(multi(err.key)));
  }
  const { entries, fullList, countText } = scan;
  const title = `${bossTitle(boss)} · ${entries.length} attended`;
  const savedLines = entries.length ? await saveScanToSite(boss, when, scan, submitterName) : [];

  // The main post is the boss, the time, the count and whether it was
  // saved; the names go in a thread on it, so the channel stays readable
  // when several bosses get logged back to back. No screenshot: a thread
  // shows the post it starts on at its top, and the image there was just
  // noise above the list.
  const embed = {
    color: 0xe74c3c,
    title: title.slice(0, 256),
    description: [`📅 <t:${when.unix}:F>`, entries.length ? multi('listInThread') : multi('noNames'), ...savedLines].join('\n'),
    footer: { text: `${countText} · logged by ${submitterName}` },
    timestamp: new Date().toISOString(),
  };

  const posted = await editOriginalResponse(applicationId, token, { embeds: [embed] });
  if (!posted || !entries.length) return;

  try {
    await postAttendeeThread(posted.channel_id, posted.id, attendanceThreadName(boss, when, entries.length), title, when, scan);
  } catch (err) {
    // No thread (e.g. the bot lacks Create Public Threads in this channel):
    // put the list back into the post itself so it isn't lost.
    console.error('/attendance could not post the attendee thread:', err);
    await editOriginalResponse(applicationId, token, { embeds: [{ ...embed, description: [`📅 <t:${when.unix}:F>`, fullList, ...savedLines].join('\n').slice(0, 4096) }] });
  }
}

// Automatic scan: a member posted screenshots in the attendance channel with
// a boss name in the message ("Kafka", "ducas 88/96"). Forwarded here by
// the always-on gateway bot (discord-bot/index.js), since only a gateway
// connection hears new messages. The thread goes on the member's own post,
// so the screenshots are never re-posted. 🔍 while reading, then ✅ / ❌.
// Returns why it skipped a message, or null once handled.
async function processAttendanceMessage({ channelId, messageId, content, imageUrls, authorName }) {
  if (String(channelId) !== ATTENDANCE_CHANNEL_ID) return 'not the attendance channel';
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

  const when = resolveEventTime(); // posted right after the fight: now
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
    if (channelId !== ATTENDANCE_CHANNEL_ID) {
      return res.json({ type: 4 /* CHANNEL_MESSAGE_WITH_SOURCE */, data: { flags: 64, content: forLocale('wrongChannel', interaction.locale, { channel: `<#${ATTENDANCE_CHANNEL_ID}>` }) } });
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
