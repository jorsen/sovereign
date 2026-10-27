// Posts (and pins) the "how to use /uniongr" guide in the growth-rate
// channel, so it's the first thing people see when they open it.
//   node post-guide.js               -- post a new guide message and pin it
//   node post-guide.js <messageId>   -- edit that existing guide in place
require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1547642467728236706';

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required (see .env.example).');
  process.exit(1);
}

const { GROWTH_GUIDE: guide } = require('./growthGuide');

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
