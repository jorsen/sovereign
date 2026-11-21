require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const sharp = require('sharp');
const { GROWTH_GUIDE, GROWTH_GUIDE_TITLE } = require('./growthGuide');

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

// A blank-name field with a line of block characters as its value -- Discord
// embeds have no built-in separator, so this is the usual way to visually
// split sections apart. ​ (zero-width space) keeps the name from
// rendering as a literal empty header.
const DIVIDER_FIELD = { name: '​', value: '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬' };

// Boss-attendance channel: members post their screenshots there with the
// boss name ("Kafka", "ducas 88/96") and the app reads the names and starts
// an attendee thread on that post.
const ATTENDANCE_CHANNEL_ID = process.env.ATTENDANCE_CHANNEL_ID || '1573000319837806622';

// MessageContent (privileged -- enable "Message Content Intent" under Bot in
// the Developer Portal) is needed to see the text and screenshots of the
// attendance posts; /uniongr itself doesn't need it.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

// Boss-name posts in the attendance channel ("Ducas" + screenshots) are
// read right here on this PC, with the app's own reading code (../lib) and
// database (DATABASE_URL from the app's root .env): the bot replies with a
// Review, and Save / Cancel on it are answered by the website. Posts made
// while this PC was off are caught up when the bot starts (and by the
// website's "Sync from Discord" button). If the app's code can't be loaded
// here, the post is handed to the website to read instead.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); // DATABASE_URL; doesn't override this folder's .env
let attendance = null;
try {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) throw new Error('DATABASE_URL is not set (put it in the root .env)');
  attendance = require('../lib/discordInteractions');
} catch (err) {
  console.error('Attendance posts will be read by the website, not this PC:', err.message);
}
// One post at a time: reading is heavy, and posts arrive in bursts.
let attendanceQueue = Promise.resolve();
const queueAttendance = (job) => (attendanceQueue = attendanceQueue.then(job).catch((err) => console.error('Attendance reading failed:', err)));

async function forwardAttendancePost(message) {
  const imageUrls = [...message.attachments.values()].filter((a) => (a.contentType || '').startsWith('image/')).map((a) => a.url);
  if (!imageUrls.length || message.hasThread) return;
  const post = {
    channelId: message.channelId,
    messageId: message.id,
    content: message.content,
    imageUrls: imageUrls.slice(0, 10),
    authorId: message.author.id,
    authorName: message.member?.displayName || message.author.globalName || message.author.username,
  };
  if (attendance) {
    return queueAttendance(async () => console.log(`attendance post ${message.id}:`, await attendance.reviewAttendancePost(post)));
  }
  const res = await fetch(`${API_BASE}/api/attendance/bot/scan-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
    body: JSON.stringify(post),
  });
  if (!res.ok) console.error('Attendance scan request failed:', res.status, await res.text().catch(() => ''));
}

// On start: read this month's boss posts that came in while the PC was off
// (and last month's, in the first days of a month).
function catchUpAttendance() {
  if (!attendance) return;
  const now = new Date();
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const months = [ym(now)];
  if (now.getDate() <= 3) months.unshift(ym(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
  for (const month of months) {
    queueAttendance(async () => {
      const r = await attendance.syncAttendanceFromDiscord({ month, budgetMs: Infinity });
      console.log(`Attendance catch-up ${month}: ${r.read} post(s) read`);
    });
  }
}

// Vercel's serverless functions hard-cap the request body around 4.5MB --
// staying comfortably under that (base64 alone inflates size by ~1/3) means
// the screenshot itself needs to be smaller than the raw limit implies.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// Downscales/re-encodes as JPEG only if the screenshot is actually large --
// most full-size game screenshots shrink dramatically this way with no
// visible quality loss on a normal display, while a small file passes
// through untouched. Falls back to the original buffer if sharp fails for
// any reason (better to attempt the original than to lose the submission).
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

// Downloads the screenshot and POSTs everything to the app under one
// discordMessageId, which is what the upsert-on-conflict in
// POST /api/growth-submissions/bot keys on.
async function submitToApi({ discordMessageId, discordUserId, discordUsername, ign, className, guildName, lampLevel, growthRate, attachmentUrl, attachmentContentType }) {
  const imageResponse = await fetch(attachmentUrl);
  if (!imageResponse.ok) throw new Error(`failed to download the attachment (${imageResponse.status})`);
  const arrayBuffer = await imageResponse.arrayBuffer();
  const { buffer, contentType: imageContentType } = await compressImageIfNeeded(Buffer.from(arrayBuffer), attachmentContentType || 'image/png');
  const imageBase64 = buffer.toString('base64');

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
    if (res.status === 413) throw new Error('the screenshot is too large even after compression -- try a smaller/cropped screenshot');
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
  // A cropped-down shot of just the stats popup (portrait/near-square) is
  // easy to fake or reuse -- a real capture of the Character Details screen
  // is landscape and shows the character on screen next to the panel.
  // Discord already reports image dimensions on the attachment, no
  // downloading/decoding needed to check this.
  if (attachment.width && attachment.height && attachment.width <= attachment.height) {
    const rejection = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('❌ Screenshot rejected')
      .setDescription("That looks like a cropped screenshot of just the stats popup, not a full screen capture.")
      .addFields({
        name: 'What we need',
        value:
          '• A **full landscape screenshot** (wider than it is tall), not a cropped portrait image.\n' +
          '• Your **character visible on screen** next to the Character Details/Artifacts panel, not just the popup by itself.\n\n' +
          'Take a normal screen capture (don\'t crop it down) and run `/uniongr` again.',
      });
    await interaction.editReply({ embeds: [rejection] });
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

  // The server nickname (falls back to the account's global display name,
  // then its username) rather than the raw account username -- that's what
  // members actually recognize each other by in this guild.
  const submitterName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;

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
    .setFooter({ text: `Submitted by ${submitterName}` })
    .setTimestamp();
  const posted = await channel.send({ embeds: [embed] });

  try {
    await submitToApi({
      discordMessageId: posted.id,
      discordUserId: interaction.user.id,
      discordUsername: submitterName,
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

// The growth-rate channel only takes submissions through the /uniongr slash
// command -- interactions never fire messageCreate, so any message we see
// here is someone typing plain chat (or typing "/uniongr" as text instead of
// picking the command). Reply with the full guide so they know what to do,
// remove that reply after a couple of minutes, and keep the guide as the
// newest message in the channel. Their own message is left alone.
const GUIDE_REPLY_TTL_MS = 2 * 60 * 1000;
let restickTimer = null;

// Same as restickGrowthGuide in lib/discordInteractions.js: drop the bot's
// previous bottom copy of the guide (never the pinned one) and post it again.
// Debounced so a burst of chat only re-posts it once.
function scheduleRestick(channel) {
  clearTimeout(restickTimer);
  restickTimer = setTimeout(async () => {
    try {
      const recent = await channel.messages.fetch({ limit: 50 });
      const oldCopies = recent.filter((m) => m.author.id === client.user.id && !m.pinned && !m.reference && m.embeds[0]?.title === GROWTH_GUIDE_TITLE);
      for (const m of oldCopies.values()) await m.delete().catch(() => {});
      await channel.send(GROWTH_GUIDE);
    } catch (err) {
      console.error('Failed to re-post the growth guide:', err);
    }
  }, 10 * 1000);
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId === ATTENDANCE_CHANNEL_ID) {
    await forwardAttendancePost(message).catch((err) => console.error('Failed to forward an attendance post:', err));
    return;
  }
  if (message.channelId !== CHANNEL_ID) return;
  const reply = await message
    .reply({ content: `${message.author} please use the **/uniongr** command here — type \`/uniongr\` and pick it from the list. How it works:`, ...GROWTH_GUIDE })
    .catch((err) => {
      console.error('Failed to reply with the guide:', err);
      return null;
    });
  if (reply) setTimeout(() => reply.delete().catch(() => {}), GUIDE_REPLY_TTL_MS);
  scheduleRestick(message.channel);
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
  console.log(`Logged in as ${client.user.tag} — watching channels ${CHANNEL_ID} (growth rate) and ${ATTENDANCE_CHANNEL_ID} (attendance)`);
  console.log(attendance ? 'Attendance posts are read on this PC.' : 'Attendance posts are handed to the website.');
  catchUpAttendance();
});

client.login(DISCORD_TOKEN);
