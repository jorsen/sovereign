// Remembers what a screenshot read as, by the screenshot's own bytes, so the
// same image is never OCR'd twice: posted again, linked again in 🎁 Add loot,
// a post re-read after "too many screenshots", or read by the PC bot first
// and then by the website (the table is shared). OCR is most of the
// website's billed CPU time.
//
// Entries are keyed by the reading code too (a fingerprint of the files
// that decide what a screenshot reads as), so any change to that code reads
// screenshots afresh. Any database trouble just means reading normally.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sql } = require('./db');

const KEEP_DAYS = 45;
// Files whose code decides what a screenshot reads as.
const READER_FILES = ['attendanceOcr.js', 'lootOcr.js', 'bosses.js', 'gameText.js'];

let fingerprint = null;
function readerFingerprint() {
  if (fingerprint) return fingerprint;
  const h = crypto.createHash('sha256');
  for (const f of READER_FILES) {
    // Line endings differ between a Windows checkout and Vercel's.
    h.update(fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n'));
  }
  const dataDir = path.join(__dirname, '..', 'ocr-data');
  for (const f of fs.readdirSync(dataDir).sort()) h.update(`${f}:${fs.statSync(path.join(dataDir, f)).size}`);
  return (fingerprint = h.digest('hex').slice(0, 16));
}

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = sql`
      CREATE TABLE IF NOT EXISTS ocr_cache (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`.catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

const off = () => process.env.OCR_CACHE === 'off' || process.env.ATTENDANCE_OCR_DEBUG || process.env.LOOT_DEBUG;

/**
 * The cached reading of `buffer`, or compute() it and remember it.
 * @param {string[]} kinds  what reading this is, best first: the first is
 *   the one stored; the others are also accepted (e.g. the PC's two-size
 *   reading is as good as the website's one-size one, or better).
 * @param {(v:any)=>any} [encode] value -> JSON; [decode] the other way.
 */
async function cachedReading(kinds, buffer, compute, { encode = (v) => v, decode = (v) => v } = {}) {
  if (off()) return compute();
  let keys;
  try {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const fp = readerFingerprint();
    keys = kinds.map((k) => `${k}:${fp}:${hash}`);
    await ensureTable();
    const { rows } = await sql`SELECT key, value FROM ocr_cache WHERE key = ANY(${keys})`;
    const hit = keys.map((k) => rows.find((r) => r.key === k)).find(Boolean);
    // Stored as JSON text (a JSONB string): JSONB itself would reorder the
    // objects' keys, and a cached reading should be the fresh one exactly.
    if (hit) return decode(JSON.parse(hit.value));
  } catch (err) {
    console.error('OCR cache lookup failed (reading normally):', err.message);
    keys = null;
  }
  const value = await compute();
  if (keys) {
    try {
      await sql`INSERT INTO ocr_cache (key, value) VALUES (${keys[0]}, ${JSON.stringify(JSON.stringify(encode(value)))}::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, created_at = NOW()`;
      if (Math.random() < 0.05) await sql`DELETE FROM ocr_cache WHERE created_at < NOW() - make_interval(days => ${KEEP_DAYS})`;
    } catch (err) {
      console.error('OCR cache save failed:', err.message);
    }
  }
  return value;
}

module.exports = { cachedReading, readerFingerprint };
