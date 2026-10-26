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

// The actual /uniongr work, run *after* Discord already has our deferred
// ack -- errors here are reported by editing that deferred response, not by
// throwing back to the HTTP handler (the response has already been sent).
async function processUniongrSubmission({ applicationId, token, interactionId, channelId, siteBaseUrl, options, resolved, member, user }) {
  // /uniongr same-ign or /uniongr changed-ign -- the fields sit inside the
  // chosen sub-command.
  const sub = options[0]?.type === 1 /* SUB_COMMAND */ ? options[0] : null;
  const fields = sub ? sub.options || [] : options;
  const getOpt = (name) => fields.find((o) => o.name === name)?.value;
  const ign = String(getOpt('ign') || '').trim();
  const className = String(getOpt('class') || '').trim();
  const guildName = getOpt('guild');
  const lampLevel = Number(getOpt('lamp'));
  const growthRate = Number(getOpt('growthrate'));
  const attachmentId = getOpt('screenshot');
  const changedIgn = sub?.name === 'changed-ign';
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
      embeds: [rejectionEmbed('❌ Old IGN missing', 'You said you changed your IGN, but did not fill in **oldign**.', 'Run `/uniongr changed-ign` again and pick your **old** IGN in the `oldign` field (start typing it to see suggestions).')],
    });
    return;
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
    }
    return res.json({ type: 8 /* APPLICATION_COMMAND_AUTOCOMPLETE_RESULT */, data: { choices: names.map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })) } });
  }

  // Unknown interaction type/command -- acknowledge harmlessly rather than
  // leaving Discord to report "did not respond".
  res.json({ type: 1 });
}

module.exports = { handleDiscordInteraction, postChannelMessage };
