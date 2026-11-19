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

/**
 * @param {string} fragment  item name as read, possibly cut off
 * @param {string} bossName  the boss that dropped it
 * @param {Array<{ name: string, boss: string, count: number }>} known
 *   item names on the site, with how often each boss has dropped them
 * @returns {{ name: string, confident: boolean, matched: boolean }}
 */
function completeItemName(fragment, bossName, known) {
  const f = norm(fragment);
  if (f.length < 4) return { name: fragment, confident: false, matched: false };

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
    .map((e) => ({ ...e, exact: norm(e.name) === f, score: 1 - substringDistance(f, norm(e.name)) / f.length }))
    .filter((e) => e.score >= MIN_SCORE)
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

module.exports = { completeItemName };
