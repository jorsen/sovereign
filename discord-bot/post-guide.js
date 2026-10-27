// Posts (and pins) the "how to use /uniongr" guide in the growth-rate
// channel, so it's the first thing people see when they open it.
//   node post-guide.js               -- post a new guide message and pin it
//   node post-guide.js <messageId>   -- edit that existing guide in place
require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1547642467728236706';
const SITE = process.env.SOVEREIGN_API_BASE || 'https://sovereign-nightcrows.vercel.app';

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required (see .env.example).');
  process.exit(1);
}

const guide = {
  embeds: [
    {
      title: '📈 How to Submit Your Growth Rate',
      color: 0x22c55e,
      description:
        'Type **`/uniongr`** in this channel and pick one of the two options below. ' +
        'Every field is required — Discord will walk you through them one by one.',
      fields: [
        {
          name: '1️⃣  `/uniongr same-ign` — Same IGN as Before / First Time',
          value:
            'Use this if your in-game name hasn\'t changed (or it\'s your first submission).\n' +
            '• **ign** — your in-game name, spelled exactly as in game\n' +
            '• **class** — pick your 4th-advancement class\n' +
            '• **guild** — pick your guild\n' +
            '• **lamp** — Volcano Lamp enhancement level (the **+** number, 1–25)\n' +
            '• **growthrate** — the Growth Rate number at the top of Character Details\n' +
            '• **screenshot** — attach your screenshot (see below)\n' +
            'It\'s saved right away ✅',
        },
        {
          name: '2️⃣  `/uniongr changed-ign` — I Changed My IGN',
          value:
            'Use this **only** if you renamed your character.\n' +
            '• **oldign** — start typing your OLD name and **pick it from the list**\n' +
            '• **ign** — your NEW in-game name\n' +
            '• then class, guild, lamp, growthrate and screenshot, same as above\n' +
            '⏳ This one waits for an **admin to approve** it. Once approved, your attendance and history move to your new name — nothing is lost.',
        },
        {
          name: '📸 Screenshot Rules',
          value:
            '• **Full landscape screenshot** showing your character **and the Artifacts tab**\n' +
            '• Don\'t crop it down to just the popup\n' +
            '• The Growth Rate and lamp level must be readable',
        },
        {
          name: '💡 Tips',
          value:
            '• Updating your Growth Rate? Just run `/uniongr same-ign` again — it replaces your old entry.\n' +
            '• Made a mistake? Submit again with the right values.\n' +
            '• The bot replies only to you (✅ or what went wrong). If `/uniongr` doesn\'t show up, ask an admin.\n' +
            `• See the list: ${SITE}/#growth`,
        },
      ],
    },
  ],
};

async function discord(method, path, body) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

(async () => {
  const existingId = process.argv[2];
  if (existingId) {
    await discord('PATCH', `/channels/${CHANNEL_ID}/messages/${existingId}`, guide);
    console.log(`Updated guide message ${existingId}.`);
    return;
  }
  const msg = await discord('POST', `/channels/${CHANNEL_ID}/messages`, guide);
  console.log(`Posted guide message ${msg.id}.`);
  try {
    await discord('PUT', `/channels/${CHANNEL_ID}/pins/${msg.id}`);
    console.log('Pinned it.');
  } catch (err) {
    console.warn(`Couldn't pin it (the bot needs the Manage Messages / Pin Messages permission): ${err.message}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
