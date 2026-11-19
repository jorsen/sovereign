// Completes item names read off the loot list. The game cuts long names off
// at the edges ("al of Advancement", "illiant Blessing Stone", "r Seal of
// Advanceme"), so each fragment is matched against the item names the site
// already has, anywhere inside them, allowing a couple of OCR slips.
//
// Pure functions: the caller passes the known items in (see
// loadKnownItems in attendanceRecords.js).

const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Edit distance between `fragment` and the best-matching stretch of `name`
// -- skipping the start or end of `name` is free, since the game cuts names
// off there.
function substringDistance(fragment, name) {
  const f = [...fragment], n = [...name];
  let prev = new Array(n.length + 1).fill(0); // free start anywhere in name
  for (let i = 1; i <= f.length; i++) {
    const cur = [i];
    for (let j = 1; j <= n.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (f[i - 1] === n[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.min(...prev); // free end anywhere in name
}

// A fragment's first and last characters are often a cut-off letter or a
// misread one ("Advancemel"), so a match needs ~85% of it to line up.
const MIN_SCORE = 0.85;
// Long fragments (10+ letters) may be off a little more: a stray "ent" in
// "scendent'sRemnant" for Forgotten Transcend's Remnant.
const LONG_MIN_SCORE = 0.8;

// Spaces don't count: the loot list's tight columns often drop or add them.
const squash = (s) => norm(s).replace(/ /g, '');
// Key the trainer stores a loot fragment under.
const lootKey = (fragment) => squash(fragment);

/**
 * @param {string} fragment  item name as read, possibly cut off
 * @param {string} bossName  the boss that dropped it
 * @param {Array<{ name: string, boss: string, count: number }>} known
 *   item names on the site, with how often each boss has dropped them
 * @param {Map<string, string>} [learned]  trainer: fragments confirmed before
 *   (lootKey -> item name), from loadLearnedItems
 * @returns {{ name: string, confident: boolean, matched: boolean }}
 */
function completeItemName(fragment, bossName, known, learned) {
  const f = squash(fragment);
  if (f.length < 4) return { name: fragment, confident: false, matched: false };
  // Trainer: this exact cut-off text was completed to this item before, and
  // the item is still on that record -- same answer again.
  if (learned && learned.has(f)) return { name: learned.get(f), confident: true, matched: true };
  const minScore = f.length >= 10 ? LONG_MIN_SCORE : MIN_SCORE;

  // One entry per distinct item name: how often it dropped at all, and from
  // this boss.
  const byName = new Map();
  for (const k of known) {
    const e = byName.get(k.name) || { name: k.name, total: 0, fromBoss: 0 };
    e.total += k.count;
    if (k.boss === bossName) e.fromBoss += k.count;
    byName.set(k.name, e);
  }

  const scored = [...byName.values()]
    .map((e) => ({ ...e, exact: squash(e.name) === f, score: 1 - substringDistance(f, squash(e.name)) / f.length }))
    .filter((e) => e.score >= minScore)
    // A full name read whole ("Blessing Stone") is that item, not a longer
    // one containing it. Otherwise the best text match; among equally good
    // ones, what this boss drops, then what drops most overall (the usual
    // spelling over a one-off typo).
    .sort((a, b) => b.exact - a.exact || b.score - a.score || b.fromBoss - a.fromBoss || b.total - a.total || a.name.length - b.name.length);

  if (!scored.length) return { name: fragment, confident: false, matched: false };
  const best = scored[0];
  if (best.exact) return { name: best.name, confident: true, matched: true };
  // Confident when nothing else fits as well, or this boss settles it.
  const rival = scored.find((e) => e !== best && e.score === best.score);
  const confident = !rival || (best.fromBoss > 0 && rival.fromBoss === 0);
  return { name: best.name, confident, matched: true };
}

module.exports = { completeItemName, lootKey };
