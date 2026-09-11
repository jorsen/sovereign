// Handles /uniongr entirely over Discord's HTTP Interactions Endpoint --
// no Gateway connection, no separate always-running bot process. Discord
// POSTs the interaction straight to this route; we verify it's really from
// Discord, ack it within 3 seconds (privately, "thinking..."), then do the
// actual work (download the screenshot, save the submission) and either
// post a public confirmation straight to the channel via the bot token, or
// edit the private deferred reply with an error.
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

async function editOriginalResponse(applicationId, token, payload) {
  const res = await fetchWithRetry(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error('editOriginalResponse failed:', res.status, await res.text().catch(() => ''));
}

// Posts the PUBLIC confirmation as a normal bot message straight to the
// channel via the bot token -- deliberately NOT using the interaction's own
// follow-up webhook. Discord has a known quirk where a follow-up can
// inherit ephemeral-ness from an ephemeral deferred original response even
// when the follow-up itself doesn't request it, which is exactly what was
// happening here (the "public" embed was only ever visible to the
// submitter). Posting straight to the channel sidesteps the interaction
// response system entirely, so there's nothing left for it to inherit from.
// `file` (optional) uploads the image bytes we already downloaded/compressed
// as a real attachment on this message, rather than pointing the embed at
// Discord's original CDN link for the interaction's attachment -- that link
// turned out not to reliably render when referenced from a *different*
// message than the one it was originally attached to. Referencing an
// upload from the SAME message via `attachment://<filename>` always works.
async function postPublicConfirmation(channelId, payload, file) {
  if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set -- cannot post the public confirmation message.');
  let body;
  let headers = { Authorization: `Bot ${DISCORD_TOKEN}` };
  if (file) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', new Blob([file.buffer], { type: file.contentType }), file.name);
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const res = await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('postPublicConfirmation failed:', res.status, text);
    throw new Error(`Discord rejected the public confirmation post (${res.status})`);
  }
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
  const getOpt = (name) => options.find((o) => o.name === name)?.value;
  const ign = String(getOpt('ign') || '').trim();
  const className = String(getOpt('class') || '').trim();
  const guildName = getOpt('guild');
  const lampLevel = Number(getOpt('lamp'));
  const growthRate = Number(getOpt('growthrate'));
  const attachmentId = getOpt('screenshot');
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

    const saveRes = await fetchWithRetry(`${siteBaseUrl}/api/growth-submissions/bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': GROWTH_BOT_SECRET },
      body: JSON.stringify({
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

    // Public confirmation post (everyone in the channel sees this), posted
    // straight to the channel rather than through the interaction webhook,
    // with the screenshot re-uploaded as this message's own attachment.
    const imageFileName = `screenshot.${imageContentType === 'image/jpeg' ? 'jpg' : imageContentType === 'image/webp' ? 'webp' : 'png'}`;
    await postPublicConfirmation(
      channelId,
      {
        embeds: [
          {
            title: ign,
            fields: [
              { name: 'Class', value: className, inline: true },
              { name: 'Guild', value: guildName, inline: true },
              { name: 'Volcano Lamp', value: `+${lampLevel}`, inline: true },
              { name: 'Growth Rate', value: growthRate.toLocaleString(), inline: true },
            ],
            image: { url: `attachment://${imageFileName}` },
            footer: { text: `Submitted by ${submitterName}` },
            timestamp: new Date().toISOString(),
          },
        ],
      },
      { buffer, contentType: imageContentType, name: imageFileName }
    );
    await editOriginalResponse(applicationId, token, { content: '✅ Saved — check the Growth Rate page.' });
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

  // Unknown interaction type/command -- acknowledge harmlessly rather than
  // leaving Discord to report "did not respond".
  res.json({ type: 1 });
}

module.exports = { handleDiscordInteraction };
