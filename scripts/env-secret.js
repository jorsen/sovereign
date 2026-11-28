// The shared settings, kept in git safely: .env.enc holds the live
// DATABASE_URL (and, only with --with-bot, the bot's settings) encrypted with
// AES-256-GCM under a passphrase (scrypt). The file is useless without the
// passphrase -- share that privately (e.g. a Discord DM), never in the repo.
//
//   node scripts/env-secret.js encrypt [--with-bot]   # .env (+ discord-bot/.env) -> .env.enc (asks for a passphrase)
//   node scripts/env-secret.js decrypt                # .env.enc -> .env (+ discord-bot/.env) (asks for it)
//
// install.bat decrypts it automatically on a PC that has no DATABASE_URL yet.
// Set ENV_PASSPHRASE to skip the question (scripts).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const BOT_ENV_FILE = path.join(ROOT, 'discord-bot', '.env');
const ENC_FILE = path.join(ROOT, '.env.enc');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SHARED_KEYS = ['DATABASE_URL'];
// These live in discord-bot/.env.
const BOT_KEYS = ['DISCORD_TOKEN', 'GROWTH_BOT_SECRET', 'SOVEREIGN_API_BASE', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID'];

function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const readEnvFile = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/** Sets KEY=value lines in an env file, keeping every other line. */
function writeEnvValues(file, values, header = []) {
  const existing = readEnvFile(file);
  const lines = existing ? existing.replace(/\s*$/, '').split(/\r?\n/) : [...header];
  const done = new Set();
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && m[1] in values) {
      done.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) out.push(`${k}=${v}`);
  fs.writeFileSync(file, `${out.join('\n')}\n`);
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
}

function encrypt(values, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  return {
    format: 'sovereign-env-v1',
    note: 'Encrypted settings for Sovereign. Unlock with the shared passphrase: node scripts/env-secret.js decrypt',
    keys: Object.keys(values),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(box, passphrase) {
  if (box.format !== 'sovereign-env-v1') throw new Error('unknown .env.enc format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(box.salt, 'base64')), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  try {
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('wrong passphrase');
  }
}

// Asks without echoing what's typed.
function askHidden(question) {
  if (process.env.ENV_PASSPHRASE) return Promise.resolve(process.env.ENV_PASSPHRASE);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/** Decrypts .env.enc; returns its values (asks for the passphrase, 3 tries). */
async function unlockShared() {
  const box = JSON.parse(fs.readFileSync(ENC_FILE, 'utf8'));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const passphrase = await askHidden('Passphrase for the shared settings (ask the admin): ');
    try {
      return decrypt(box, passphrase);
    } catch (err) {
      if (process.env.ENV_PASSPHRASE || attempt === 3) throw err;
      console.log('  Wrong passphrase -- try again.');
    }
  }
}

/** Splits values into the root .env part and the discord-bot/.env part. */
function splitValues(values) {
  const root = {};
  const bot = {};
  for (const [k, v] of Object.entries(values)) (BOT_KEYS.includes(k) ? bot : root)[k] = v;
  return { root, bot };
}

module.exports = { unlockShared, splitValues, parseEnv, readEnvFile, writeEnvValues, ENC_FILE, ENV_FILE, BOT_ENV_FILE };

if (require.main === module) {
  (async () => {
    const cmd = process.argv[2];
    if (cmd === 'encrypt') {
      const env = { ...parseEnv(readEnvFile(BOT_ENV_FILE)), ...parseEnv(readEnvFile(ENV_FILE)) };
      const keys = [...SHARED_KEYS, ...(process.argv.includes('--with-bot') ? BOT_KEYS : [])].filter((k) => env[k]);
      if (!keys.includes('DATABASE_URL')) throw new Error('.env has no DATABASE_URL');
      const passphrase = await askHidden('New passphrase (12+ characters): ');
      if (passphrase.length < 12) throw new Error('passphrase too short -- use 12+ characters');
      if (!process.env.ENV_PASSPHRASE && (await askHidden('Same passphrase again: ')) !== passphrase) throw new Error('the two passphrases differ');
      const values = Object.fromEntries(keys.map((k) => [k, env[k]]));
      fs.writeFileSync(ENC_FILE, `${JSON.stringify(encrypt(values, passphrase), null, 2)}\n`);
      console.log(`Wrote ${path.basename(ENC_FILE)} with: ${keys.join(', ')}. Commit it; share the passphrase privately.`);
    } else if (cmd === 'decrypt') {
      const { root, bot } = splitValues(await unlockShared());
      if (Object.keys(root).length) writeEnvValues(ENV_FILE, root);
      if (Object.keys(bot).length) writeEnvValues(BOT_ENV_FILE, bot);
      console.log(`Unlocked: ${[...Object.keys(root), ...Object.keys(bot)].join(', ')}`);
    } else {
      console.log('usage: node scripts/env-secret.js encrypt [--with-bot] | decrypt');
      process.exitCode = 1;
    }
  })().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  });
}
