require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1547642467728236706';
const API_BASE = (process.env.SOVEREIGN_API_BASE || '').replace(/\/+$/, '');
const BOT_SECRET = process.env.GROWTH_BOT_SECRET;

if (!DISCORD_TOKEN || !API_BASE || !BOT_SECRET) {
  console.error('DISCORD_TOKEN, SOVEREIGN_API_BASE, and GROWTH_BOT_SECRET are all required (see .env.example).');
  process.exit(1);
}

// MessageContent is a privileged intent -- it must also be turned on for
// this bot application under Developer Portal > Bot > Privileged Gateway
// Intents, or every message arrives with an empty .content.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

// Matches "IGN: whatever" / "Class: whatever" anywhere in the message,
// case-insensitive, in either order, one per line -- `.` already excludes
// newlines in JS regex, so this naturally stops at end-of-line without
// needing the /s flag.
function parseSubmission(content) {
  const ignMatch = content.match(/ign\s*:\s*(.+)/i);
  const classMatch = content.match(/class\s*:\s*(.+)/i);
  return {
    ign: ignMatch ? ignMatch[1].trim() : null,
    className: classMatch ? classMatch[1].trim() : null,
  };
}

function firstImageAttachment(message) {
  return message.attachments.find((a) => (a.contentType || '').startsWith('image/'));
}

async function submitToApi(message, ign, className, attachment) {
  const imageResponse = await fetch(attachment.url);
  if (!imageResponse.ok) throw new Error(`failed to download the attachment (${imageResponse.status})`);
  const arrayBuffer = await imageResponse.arrayBuffer();
  const imageBase64 = Buffer.from(arrayBuffer).toString('base64');
  const imageContentType = attachment.contentType || 'image/png';

  const res = await fetch(`${API_BASE}/api/growth-submissions/bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
    body: JSON.stringify({
      discordMessageId: message.id,
      discordUserId: message.author.id,
      discordUsername: message.author.username,
      ign,
      class: className,
      imageBase64,
      imageContentType,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `the app returned ${res.status}`);
  }
}

async function handleMessage(message) {
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author?.bot) return;

  const { ign, className } = parseSubmission(message.content || '');
  const attachment = firstImageAttachment(message);

  const missing = [];
  if (!ign) missing.push('`IGN:`');
  if (!className) missing.push('`Class:`');
  if (!attachment) missing.push('a screenshot attachment');

  if (missing.length) {
    try {
      await message.react('❌');
      await message.reply(
        `Missing ${missing.join(', ')}. Please post like:\n\`\`\`\nIGN: YourName\nClass: YourClass\n\`\`\`\n...with your Artifacts-tab growth rate screenshot attached.`
      );
    } catch (err) {
      console.error('Failed to notify about an incomplete submission:', err);
    }
    return;
  }

  try {
    await submitToApi(message, ign, className, attachment);
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

// Deleting the source message removes the growth-rate entry too, rather than
// leaving an orphaned submission with no way to trace it back.
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
