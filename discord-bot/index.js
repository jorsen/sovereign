require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1547642467728236706';
const API_BASE = (process.env.SOVEREIGN_API_BASE || '').replace(/\/+$/, '');
const BOT_SECRET = process.env.GROWTH_BOT_SECRET;

if (!DISCORD_TOKEN || !API_BASE || !BOT_SECRET) {
  console.error('DISCORD_TOKEN, SOVEREIGN_API_BASE, and GROWTH_BOT_SECRET are all required (see .env.example).');
  process.exit(1);
}

// Kept in sync with register-commands.js's /uniongr guild choices and with
// the Sovereign app's own server-side check on POST /api/growth-submissions/bot.
const VALID_GUILDS = ['Helloシ', '貓貓客棧', '巫女組', 'CAPITAL'];

// Kept in sync with register-commands.js's /uniongr class choices -- every
// 4th-advancement (final tier) class name, since that's the only tier this
// list tracks.
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

// The Volcano Lamp only goes up to +25. Kept in sync with
// register-commands.js's setMinValue/setMaxValue and the app's own
// server-side check.
const LAMP_MIN = 1;
const LAMP_MAX = 25;
function isValidLampLevel(n) {
  return Number.isInteger(n) && n >= LAMP_MIN && n <= LAMP_MAX;
}

// MessageContent is a privileged intent -- it must also be turned on for
// this bot application under Developer Portal > Bot > Privileged Gateway
// Intents, or every message arrives with an empty .content. It's only
// needed for the free-text channel flow below, not for the /uniongr slash
// command (interactions always carry their option values regardless).
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

// Shared by both submission paths (the /uniongr slash command and the plain
// free-text channel message) -- downloads the screenshot and POSTs
// everything to the app under one discordMessageId, which is what the
// upsert-on-conflict in POST /api/growth-submissions/bot keys on.
async function submitToApi({ discordMessageId, discordUserId, discordUsername, ign, className, guildName, lampLevel, attachmentUrl, attachmentContentType }) {
  const imageResponse = await fetch(attachmentUrl);
  if (!imageResponse.ok) throw new Error(`failed to download the attachment (${imageResponse.status})`);
  const arrayBuffer = await imageResponse.arrayBuffer();
  const imageBase64 = Buffer.from(arrayBuffer).toString('base64');
  const imageContentType = attachmentContentType || 'image/png';

  const res = await fetch(`${API_BASE}/api/growth-submissions/bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
    body: JSON.stringify({
      discordMessageId,
      discordUserId,
      discordUsername,
      ign,
      class: className,
      guildName,
      lampLevel,
      imageBase64,
      imageContentType,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `the app returned ${res.status}`);
  }
}

// ---------- Path 1: /uniongr slash command ----------
// The bot posts a confirmation message (with the screenshot) into the
// growth-rate channel itself, then uses THAT message's id as the
// discordMessageId -- so if a mod deletes that confirmation post later, the
// existing messageDelete handler below cleans up the submission the same
// way it already does for the free-text flow, with no separate code path.
async function handleGrowthCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const ign = interaction.options.getString('ign', true).trim();
  const className = interaction.options.getString('class', true).trim();
  const guildName = interaction.options.getString('guild', true);
  const lampLevel = interaction.options.getInteger('lamp', true);
  const attachment = interaction.options.getAttachment('screenshot', true);

  if (!(attachment.contentType || '').startsWith('image/')) {
    await interaction.editReply('The screenshot attachment has to be an image.');
    return;
  }
  // The command's own .addChoices() already constrains these in the Discord
  // UI, but a stale client cache or a raw API call could still send
  // something else -- worth a clear error instead of an opaque 400 later.
  if (!VALID_GUILDS.includes(guildName)) {
    await interaction.editReply(`Guild must be one of: ${VALID_GUILDS.join(', ')}`);
    return;
  }
  if (!VALID_CLASSES.includes(className)) {
    await interaction.editReply(`Class must be one of: ${VALID_CLASSES.join(', ')}`);
    return;
  }
  if (!isValidLampLevel(lampLevel)) {
    await interaction.editReply(`Volcano Lamp level must be an integer between ${LAMP_MIN} and ${LAMP_MAX}.`);
    return;
  }

  const channel = await client.channels.fetch(CHANNEL_ID);
  const embed = new EmbedBuilder()
    .setTitle(ign)
    .addFields(
      { name: 'Class', value: className, inline: true },
      { name: 'Guild', value: guildName, inline: true },
      { name: 'Volcano Lamp', value: `+${lampLevel}`, inline: true }
    )
    .setImage(attachment.url)
    .setFooter({ text: `Submitted by ${interaction.user.username}` })
    .setTimestamp();
  const posted = await channel.send({ embeds: [embed] });

  try {
    await submitToApi({
      discordMessageId: posted.id,
      discordUserId: interaction.user.id,
      discordUsername: interaction.user.username,
      ign,
      className,
      guildName,
      lampLevel,
      attachmentUrl: attachment.url,
      attachmentContentType: attachment.contentType,
    });
    await interaction.editReply('✅ Saved — check the Growth Rate page.');
  } catch (err) {
    console.error('Failed to submit a growth entry via /uniongr:', err);
    await posted.delete().catch(() => {});
    await interaction.editReply(`Something went wrong saving this: ${err.message}`);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'uniongr') return;
  try {
    await handleGrowthCommand(interaction);
  } catch (err) {
    console.error('Unhandled error in /uniongr:', err);
    const reply = { content: 'Something went wrong. Please try again.' };
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
    else await interaction.reply({ ...reply, ephemeral: true }).catch(() => {});
  }
});

// ---------- Path 2: plain free-text message in the channel ----------
// Matches "IGN: whatever" / "Class: whatever" anywhere in the message,
// case-insensitive, in either order, one per line -- `.` already excludes
// newlines in JS regex, so this naturally stops at end-of-line without
// needing the /s flag. Kept alongside /uniongr for anyone who'd rather just
// type it than fill in a command's fields.
function parseSubmission(content) {
  const ignMatch = content.match(/ign\s*:\s*(.+)/i);
  const classMatch = content.match(/class\s*:\s*(.+)/i);
  const guildMatch = content.match(/guild\s*:\s*(.+)/i);
  // Matches "Lamp: 14", "Volcano Lamp: +14", "Lamp +14", etc. -- the "+" is
  // optional and ignored either way, only the number is captured.
  const lampMatch = content.match(/(?:volcano\s*)?lamp\s*:?\s*\+?\s*(\d+)/i);
  const guildRaw = guildMatch ? guildMatch[1].trim() : null;
  const classRaw = classMatch ? classMatch[1].trim() : null;
  // Case-insensitive match against the known lists -- but stores the
  // canonical spelling/casing from VALID_GUILDS/VALID_CLASSES, not whatever
  // casing/whitespace the person happened to type.
  const guildName = guildRaw ? VALID_GUILDS.find((g) => g.toLowerCase() === guildRaw.toLowerCase()) || null : null;
  const className = classRaw ? VALID_CLASSES.find((c) => c.toLowerCase() === classRaw.toLowerCase()) || null : null;
  const lampRaw = lampMatch ? Number(lampMatch[1]) : null;
  const lampLevel = lampRaw !== null && isValidLampLevel(lampRaw) ? lampRaw : null;
  return {
    ign: ignMatch ? ignMatch[1].trim() : null,
    className,
    guildName,
    lampLevel,
  };
}

function firstImageAttachment(message) {
  return message.attachments.find((a) => (a.contentType || '').startsWith('image/'));
}

// Only treat a message as a submission *attempt* worth responding to if it
// has an attachment or mentions one of the expected labels -- otherwise
// regular chat in the channel (or someone typing "/uniongr" as plain text
// because the slash command isn't showing up for them) would get a
// "Missing..." reply spammed at it for no reason.
function looksLikeSubmissionAttempt(message) {
  if (message.attachments.size > 0) return true;
  return /\b(ign|class|guild|lamp)\s*:/i.test(message.content || '');
}

async function handleMessage(message) {
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author?.bot) return;
  if (!looksLikeSubmissionAttempt(message)) return;

  const { ign, className, guildName, lampLevel } = parseSubmission(message.content || '');
  const attachment = firstImageAttachment(message);

  const missing = [];
  if (!ign) missing.push('`IGN:`');
  if (!className) missing.push(`\`Class:\` (one of ${VALID_CLASSES.join(', ')})`);
  if (!guildName) missing.push(`\`Guild:\` (one of ${VALID_GUILDS.join(', ')})`);
  if (lampLevel === null) missing.push(`\`Lamp:\` (an integer between ${LAMP_MIN} and ${LAMP_MAX})`);
  if (!attachment) missing.push('a screenshot attachment');

  if (missing.length) {
    try {
      await message.react('❌');
      await message.reply(
        `Missing ${missing.join(', ')}. Use \`/uniongr\` instead, or post like:\n\`\`\`\nIGN: YourName\nClass: YourClass\nGuild: YourGuild\nLamp: 14\n\`\`\`\n...with your Artifacts-tab growth rate screenshot attached.`
      );
    } catch (err) {
      console.error('Failed to notify about an incomplete submission:', err);
    }
    return;
  }

  try {
    await submitToApi({
      discordMessageId: message.id,
      discordUserId: message.author.id,
      discordUsername: message.author.username,
      ign,
      className,
      guildName,
      lampLevel,
      attachmentUrl: attachment.url,
      attachmentContentType: attachment.contentType,
    });
    await message.react('✅');
  } catch (err) {
    console.error('Failed to submit a growth entry:', err);
    try {
      await message.react('⚠️');
      await message.reply(`Something went wrong saving this: ${err.message}`);
    } catch {
      // best-effort -- don't let a failed reply crash the handler
    }
  }
}

client.on('messageCreate', handleMessage);

// Someone fixing a typo'd IGN/Class after the fact -- re-parse and let the
// API's upsert-by-discord-message-id update the same row instead of leaving
// the original (now-stale) submission in place.
client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    const full = newMessage.partial ? await newMessage.fetch() : newMessage;
    await handleMessage(full);
  } catch (err) {
    console.error('Failed to handle an edited message:', err);
  }
});

// Deleting the source message (whether it was a free-text submission or the
// bot's own /uniongr confirmation post) removes the growth-rate entry too,
// rather than leaving an orphaned submission with no way to trace it back.
client.on('messageDelete', async (message) => {
  if (message.channelId !== CHANNEL_ID) return;
  try {
    await fetch(`${API_BASE}/api/growth-submissions/bot/by-message/${message.id}`, {
      method: 'DELETE',
      headers: { 'x-bot-secret': BOT_SECRET },
    });
  } catch (err) {
    console.error('Failed to remove a deleted submission:', err);
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag} — watching channel ${CHANNEL_ID}`);
});

client.login(DISCORD_TOKEN);
