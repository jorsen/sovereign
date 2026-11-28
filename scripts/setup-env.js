// Interactive setup (called by install.bat). Fills in what's missing:
//   .env              DATABASE_URL (live database), SESSION_SECRET, PORT=3001
//   discord-bot/.env  DISCORD_TOKEN, GROWTH_BOT_SECRET, SOVEREIGN_API_BASE
//                     -- only on the one PC that runs the bot
// keeps every other line already in those files, then tests both connections.
//
//   node scripts/setup-env.js            # ask only for what's missing
//   node scripts/setup-env.js --reset    # ask for everything again
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const {
  unlockShared, splitValues, parseEnv, readEnvFile, writeEnvValues, ENC_FILE, ENV_FILE, BOT_ENV_FILE,
} = require('./env-secret');

const RESET = process.argv.includes('--reset');
const SITE = 'https://sovereign-nightcrows.vercel.app';
const LOCAL_PORT = '3001'; // Capital Records uses 3000 on the same PC.

// Made on first question, so the passphrase prompt (its own reader) can run first.
let rl = null;
const ask = (q) => new Promise((resolve) => {
  rl = rl || readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => resolve(a.trim()));
});

async function askUntil(question, valid, { optional = false } = {}) {
  for (;;) {
    const answer = await ask(question);
    if (!answer && optional) return '';
    if (valid(answer)) return answer;
    console.log('  That doesn\'t look right -- please paste it again.');
  }
}

async function testDatabase(url) {
  process.env.DATABASE_URL = url;
  const { sql } = require('../lib/db');
  const { rows } = await sql`SELECT (SELECT COUNT(*) FROM sovereign_members) AS members, (SELECT COUNT(*) FROM world_boss_attendance) AS kills`;
  return rows[0];
}

async function testBot(token) {
  const res = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${token}` } });
  if (!res.ok) throw new Error(`Discord answered ${res.status}`);
  return (await res.json()).username;
}

(async () => {
  const root = parseEnv(readEnvFile(ENV_FILE));
  const bot = parseEnv(readEnvFile(BOT_ENV_FILE));
  const rootUpdates = {};
  const botUpdates = {};

  console.log('\n=== Sovereign settings (.env and discord-bot\\.env) ===\n');

  // The shared settings committed in encrypted form (scripts/env-secret.js):
  // one passphrase instead of pasting the database URL.
  if ((RESET || !root.DATABASE_URL) && fs.existsSync(ENC_FILE)) {
    try {
      const shared = splitValues(await unlockShared());
      Object.assign(rootUpdates, shared.root);
      if (RESET || !bot.DISCORD_TOKEN) Object.assign(botUpdates, shared.bot);
      console.log(`Shared settings unlocked (${[...Object.keys(shared.root), ...Object.keys(shared.bot)].join(', ')}).`);
    } catch (err) {
      console.log(`Could not unlock the shared settings (${err.message}) -- enter the database URL instead.`);
    }
  }

  if (rootUpdates.DATABASE_URL) {
    // from the shared settings
  } else if (RESET || !root.DATABASE_URL) {
    console.log('Live database URL: Vercel -> sovereign -> Storage (or Neon -> Connect), the "postgresql://..." one.');
    rootUpdates.DATABASE_URL = await askUntil('DATABASE_URL: ', (v) => /^postgres(ql)?:\/\/\S+$/.test(v));
  } else {
    console.log('DATABASE_URL: already set.');
  }
  if (!root.SESSION_SECRET) rootUpdates.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  if (root.PORT !== LOCAL_PORT) rootUpdates.PORT = LOCAL_PORT;

  if (botUpdates.DISCORD_TOKEN) {
    // from the shared settings
  } else if (RESET || !bot.DISCORD_TOKEN) {
    console.log('\nDiscord bot token -- ONLY on the one PC that runs the bot.');
    console.log('On every other PC just press Enter (the website works without it; two bots would answer every post twice).');
    const token = await askUntil('DISCORD_TOKEN: ', (v) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(v), { optional: true });
    if (token) botUpdates.DISCORD_TOKEN = token;
  } else {
    console.log('DISCORD_TOKEN: already set.');
  }

  const botToken = botUpdates.DISCORD_TOKEN || bot.DISCORD_TOKEN;
  if (botToken) {
    if (!botUpdates.GROWTH_BOT_SECRET && (RESET || !bot.GROWTH_BOT_SECRET)) {
      console.log('\nGROWTH_BOT_SECRET: the same value as in Vercel -> sovereign -> Settings -> Environment Variables.');
      botUpdates.GROWTH_BOT_SECRET = await askUntil('GROWTH_BOT_SECRET: ', (v) => v.length >= 8);
    }
    if (!botUpdates.SOVEREIGN_API_BASE && !bot.SOVEREIGN_API_BASE) botUpdates.SOVEREIGN_API_BASE = SITE;
  }

  if (rl) rl.close();
  if (Object.keys(rootUpdates).length) {
    writeEnvValues(ENV_FILE, rootUpdates, [
      '# Local settings for Sovereign (website). Never commit or share this file.',
      '# DATABASE_URL is the LIVE database: changes made locally change the real data.',
    ]);
    console.log(`\nSaved to ${ENV_FILE}`);
  }
  if (Object.keys(botUpdates).length) {
    writeEnvValues(BOT_ENV_FILE, botUpdates, ['# Sovereign Discord bot settings. Never commit or share this file.']);
    console.log(`Saved to ${BOT_ENV_FILE}`);
  }

  let ok = true;
  try {
    const r = await testDatabase(rootUpdates.DATABASE_URL || root.DATABASE_URL);
    console.log(`Database: OK (${r.members} members, ${r.kills} boss kills).`);
  } catch (err) {
    ok = false;
    console.log(`Database: FAILED -- ${err.message}\n  Re-enter it: node scripts/setup-env.js --reset`);
  }
  if (botToken) {
    try {
      console.log(`Discord bot: OK (logged in as ${await testBot(botToken)}).`);
    } catch (err) {
      ok = false;
      console.log(`Discord bot: FAILED -- ${err.message}. Check the token (node scripts/setup-env.js --reset).`);
    }
  }
  process.exitCode = ok ? 0 : 1;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
