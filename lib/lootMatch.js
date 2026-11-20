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
 * @param {{ icon?: string, icons?: Map<string, string[]> }} [look]  the row's
 *   icon fingerprint (lootOcr) and the icons learned per item name
 * @returns {{ name: string, confident: boolean, matched: boolean, byText: boolean, candidates?: string[] }}
 *   byText: the text alone named the item (so its icon can be learned);
 *   candidates: the items a cut-off name fits equally, when it couldn't be
 *   settled (not matched then -- shown with ❓, not saved)
 */
function completeItemName(fragment, bossName, known, learned, look = {}) {
  const f = squash(fragment);
  if (f.length < 4) return { name: fragment, confident: false, matched: false };
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

  if (!scored.length) {
    const garbled = clearWinner(f, byName);
    if (garbled) return garbled;
    // Garbled beyond reading: the icon may still say which item it is.
    const seen = iconMatch(look, [...byName.keys()]);
    return seen ? { name: seen, confident: true, matched: true, byText: false } : { name: fragment, confident: false, matched: false };
  }
  const best = scored[0];
  if (best.exact) return { name: best.name, confident: true, matched: true, byText: true };
  // Every item the text fits as well as the best one. One: that's it.
  const tied = scored.filter((e) => best.score - e.score < 0.001);
  if (tied.length === 1) {
    const learnedName = learned?.get(f);
    return { name: learnedName && byName.has(learnedName) ? learnedName : best.name, confident: true, matched: true, byText: true };
  }
  // A cut-off name several items end with ("Enhancement Scroll": Brilliant
  // Armor, Pitch Black Accessory, ...): the text can't tell. The icon can,
  // once this item's icon has been seen before.
  const names = tied.map((e) => e.name);
  const seen = iconMatch(look, names) || referenceMatch(look, names);
  if (seen) return { name: seen, confident: true, matched: true, byText: false };
  // No icon to go by yet: the best guess from what this boss (then any boss)
  // dropped before -- only a guess (it picked Pitch Black Accessory for a
  // Brilliant Armor scroll once). `candidates` stays on it so the icon is
  // learned from the record: whichever candidate is on it after admins'
  // fixes, and from then on the icon decides.
  return { name: best.name, confident: false, matched: true, byText: false, candidates: names };
}

// The item among `names` whose learned icon this row's icon matches: the
// same item's icon differs by ~0-9 between screenshots (size, JPEG), other
// items' by 12+.
const ICON_SAME_ITEM = 10;
const ICON_MIN_LEAD = 4;
// Reference icons (lib/itemIcons.json, from in-game pictures of the items):
// the 8 enhancement scrolls are "... Enhancement Scroll" on a cut-off loot
// row. Brilliant vs Pitch Black differ in color (6x6 fingerprint, ~31
// apart); Weapon / Armor / Accessory / Artifact only in the symbol (shape
// fingerprint: ~0.3 same symbol, 0.5+ different). Score = shape + color/100.
const REFERENCE_ICONS = require('./itemIcons.json');
const REF_MAX_SCORE = 0.5;
const REF_MIN_LEAD = 0.12;
function referenceMatch({ icon, shape } = {}, names) {
  if (!icon || !shape) return null;
  const { iconDistance, shapeDistance } = require('./lootOcr');
  const lower = names.map((n) => n.toLowerCase());
  const ranked = REFERENCE_ICONS
    .filter((r) => lower.includes(r.name.toLowerCase()))
    .map((r) => ({ name: names[lower.indexOf(r.name.toLowerCase())], score: shapeDistance(shape, r.shape) + iconDistance(icon, r.color) / 100 }))
    .sort((a, b) => a.score - b.score);
  const [best, next] = ranked;
  if (!best || best.score > REF_MAX_SCORE) return null;
  if (next && next.score - best.score < REF_MIN_LEAD) return null;
  return best.name;
}

function iconMatch({ icon, icons } = {}, names) {
  if (!icon || !icons?.size) return null;
  const { iconDistance } = require('./lootOcr');
  const ranked = names
    .map((name) => ({ name, d: Math.min(Infinity, ...(icons.get(name) || []).map((x) => iconDistance(icon, x))) }))
    .sort((a, b) => a.d - b.d);
  const [best, next] = ranked;
  if (!best || best.d > ICON_SAME_ITEM) return null;
  if (next && next.d - best.d < ICON_MIN_LEAD) return null;
  return best.name;
}

// A long row read badly all through ("EaeencelniEurses" for Essence of
// Curses: 63% alike, nothing else above 44%) still names an item when one
// item is far ahead of every other -- a garbled read of a real item, not an
// item missing from the site's list.
const GARBLED_MIN_LENGTH = 12;
const GARBLED_MIN_SCORE = 0.55;
const GARBLED_MIN_LEAD = 0.15;
function clearWinner(f, byName) {
  if (f.length < GARBLED_MIN_LENGTH) return null;
  const [best, next] = [...byName.values()]
    .map((e) => ({ name: e.name, score: 1 - substringDistance(f, squash(e.name)) / f.length }))
    .sort((a, b) => b.score - a.score);
  if (!best || best.score < GARBLED_MIN_SCORE || best.score - (next?.score ?? 0) < GARBLED_MIN_LEAD) return null;
  return { name: best.name, confident: false, matched: true, byText: true };
}

module.exports = { completeItemName, lootKey };
