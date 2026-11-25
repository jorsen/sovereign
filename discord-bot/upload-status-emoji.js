// One-time: uploads assets/status-online.gif (make-status-emoji.js) as an
// emoji of the bot application -- usable by the bot in any server, and not
// taking one of the server's emoji slots. Prints the emoji's id, which goes
// into STATUS_ONLINE_EMOJI in lib/discordInteractions.js. Re-running
// replaces the existing one (new id).
//   node upload-status-emoji.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const NAME = 'bot_online';
const { DISCORD_TOKEN, DISCORD_CLIENT_ID } = process.env;
const api = (p, init = {}) =>
  fetch(`https://discord.com/api/v10/applications/${DISCORD_CLIENT_ID}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${DISCORD_TOKEN}`, ...(init.headers || {}) },
  });

(async () => {
  const list = await (await api('/emojis')).json();
  for (const e of list.items || []) {
    if (e.name === NAME) await api(`/emojis/${e.id}`, { method: 'DELETE' });
  }
  const gif = fs.readFileSync(path.join(__dirname, 'assets', 'status-online.gif')).toString('base64');
  const res = await api('/emojis', { method: 'POST', body: JSON.stringify({ name: NAME, image: `data:image/gif;base64,${gif}` }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`Discord refused the emoji (${res.status}): ${JSON.stringify(body)}`);
  console.log(`Uploaded :${body.name}: -- id ${body.id}, animated: ${body.animated}`);
  console.log(`Use it as <a:${body.name}:${body.id}>`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
