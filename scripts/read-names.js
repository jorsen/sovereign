// Try the attendance name reader on local screenshots without going through
// Discord:  npm run read-names -- path/to/shot1.png [shot2.png ...]
// If DATABASE_URL is set (environment or root .env), readings are also
// matched against the Growth Rate list, same as /attendance does.
const fs = require('fs');
const path = require('path');
const { readNamesFromScreenshot, mergeNameLists } = require('../lib/attendanceOcr');
const { matchToRoster } = require('../lib/rosterMatch');

// Tiny .env loader (the app itself gets its env from Vercel).
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  // Strip a UTF-8 byte-order mark: Windows editors add one, and it would
  // hide whatever variable is on the first line.
  for (const line of fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function loadGrowthRateNames() {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return null;
  const { sql } = require('../lib/db');
  const { rows } = await sql`SELECT DISTINCT TRIM(ign) AS name FROM growth_submissions WHERE TRIM(ign) <> ''`;
  return rows.map((r) => r.name);
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: npm run read-names -- <screenshot> [more screenshots...]');
    process.exit(1);
  }
  const lists = [];
  for (const file of files) {
    const started = Date.now();
    const names = await readNamesFromScreenshot(fs.readFileSync(file));
    console.log(`\n${path.basename(file)}: ${names.length} names (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    for (const n of names) console.log(`  ${n.color.padEnd(11)} ${n.name}${n.uncertain ? '  (uncertain)' : ''}`);
    lists.push(names);
  }
  const merged = mergeNameLists(lists);
  const roster = await loadGrowthRateNames();
  if (!roster) {
    console.log(`\nMerged: ${merged.length} names (set DATABASE_URL to match against the Growth Rate list)`);
    for (const n of merged) console.log(`  • ${n.name}${n.uncertain ? ' ⚠️' : ''}`);
  } else {
    const matched = matchToRoster(lists.flat(), roster);
    console.log(`\nMatched against ${roster.length} Growth Rate names: ${matched.length} attended`);
    for (const n of matched) {
      const mark = n.status === 'unknown' ? ' ❓ not on the list' : n.confident ? '' : ' ⚠️';
      console.log(`  • ${n.name}${mark}${n.readAs !== n.name ? `   (read as ${n.readAs})` : ''}`);
    }
  }
  process.exit(0); // the OCR worker threads would otherwise keep node alive
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
