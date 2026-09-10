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
const VALID_GUILDS = ['Helloシ', '貓貓客棧', '巫女組', 'CAPITAL', 'BUBBLEGANG'];

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

// Submissions only come through the /uniongr slash command -- interactions
// always carry their option values regardless of message content, so no
// MessageContent privileged intent is needed here.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message, Partials.Channel],
});

// Downloads the screenshot and POSTs everything to the app under one
// discordMessageId, which is what the upsert-on-conflict in
// POST /api/growth-submissions/bot keys on.
async function submitToApi({ discordMessageId, discordUserId, discordUsername, ign, className, guildName, lampLevel, growthRate, attachmentUrl, attachmentContentType }) {
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
      growthRate,
      imageBase64,
      imageContentType,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `the app returned ${res.status}`);
  }
}

// The bot posts a confirmation message (with the screenshot) into the
// growth-rate channel itself, then uses THAT message's id as the
// discordMessageId -- so if a mod deletes that confirmation post later, the
// messageDelete handler below cleans up the submission automatically.
async function handleGrowthCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const ign = interaction.options.getString('ign', true).trim();
  const className = interaction.options.getString('class', true).trim();
  const guildName = interaction.options.getString('guild', true);
  const lampLevel = interaction.options.getInteger('lamp', true);
  const growthRate = interaction.options.getInteger('growthrate', true);
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
  if (!Number.isInteger(growthRate) || growthRate < 0) {
    await interaction.editReply('Growth Rate must be a non-negative integer.');
    return;
  }

  const channel = await client.channels.fetch(CHANNEL_ID);
  const embed = new EmbedBuilder()
    .setTitle(ign)
    .addFields(
      { name: 'Class', value: className, inline: true },
      { name: 'Guild', value: guildName, inline: true },
      { name: 'Volcano Lamp', value: `+${lampLevel}`, inline: true },
      { name: 'Growth Rate', value: growthRate.toLocaleString(), inline: true }
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
      growthRate,
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

// Deleting the bot's own /uniongr confirmation post removes the growth-rate
// entry too, rather than leaving an orphaned submission with no way to
// trace it back.
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
