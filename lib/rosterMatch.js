// Snaps OCR'd attendance names onto known member names (the Growth Rate
// list), so "IicyFraith" becomes "JuicyFruit" and the posted list uses the
// exact spelling the site already has.
//
// Pure functions, no database: the caller passes the roster in.

const { NAME_ALIASES } = require('./nameAliases');

// Dedupe/compare key: letters and digits only, lowercased, NFKC-folded.
function nameKey(name) {
  return String(name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// The Latin part of a guild-tag name: 자본丶Suszane -> suszane. OCR mangles
// the Korean/Chinese prefix far more often than the Latin part, so this is
// compared on its own too.
function latinTail(name) {
  const m = String(name || '').normalize('NFKC').match(/^[^A-Za-z0-9]*?[\p{Script=Hangul}\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}][^A-Za-z0-9]*([A-Za-z0-9].*)$/u);
  return m ? nameKey(m[1]) : null;
}

// Letters Tesseract mixes up on this font; swapping one for another costs
// half an edit.
const LOOKALIKES = ['il1|j!', 'o0', 's5', 'b8', 'z2', 'g9q', 'uv', 'ce', 'ft', 'nh', 'xk'];
const LOOKALIKE_OF = new Map();
LOOKALIKES.forEach((group, i) => [...group].forEach((ch) => LOOKALIKE_OF.set(ch, i)));
function substitutionCost(a, b) {
  if (a === b) return 0;
  const ga = LOOKALIKE_OF.get(a);
  return ga !== undefined && ga === LOOKALIKE_OF.get(b) ? 0.5 : 1;
}

function editDistance(a, b) {
  const A = [...a], B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + substitutionCost(A[i - 1], B[j - 1]));
    }
    prev = cur;
  }
  return prev[B.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const len = Math.max([...a].length, [...b].length);
  return 1 - editDistance(a, b) / len;
}

// Number names (-41-): Tesseract reads digits in this font as look-alike
// letters (-41- came out as —AT— and —al—), so for an all-digit member a
// dash-framed reading is also compared with those letters turned back into
// digits. Only dash-framed: otherwise any short garbage reading ("사보",
// "al") could turn into a number name.
const DIGIT_LOOKALIKES = { o: '0', d: '0', i: '1', l: '1', t: '1', j: '1', z: '2', e: '3', a: '4', h: '4', s: '5', g: '6', b: '8', q: '9' };
function asDigits(key) {
  return [...key].map((ch) => DIGIT_LOOKALIKES[ch] || ch).join('');
}

// Best of: whole name vs whole name, and Latin part vs Latin part (or vs
// the whole other name, for when only one side carries the guild tag).
// Matches made only on the Latin part count a little less.
function score(read, member) {
  let best = similarity(read.key, member.key);
  if (read.dashFramed && /^\d+$/.test(member.key)) best = Math.max(best, similarity(asDigits(read.key), member.key) * 0.9);
  const pairs = [
    [read.tail, member.tail],
    [read.tail, member.key],
    [read.key, member.tail],
  ];
  for (const [a, b] of pairs) {
    if (a && b && Math.min([...a].length, [...b].length) >= 4) best = Math.max(best, similarity(a, b) * 0.95);
  }
  return best;
}

// Below MIN_SCORE a reading is left as-is (probably someone not on the
// list yet). A match also has to beat the runner-up clearly, so two
// similar roster names (Jenn / Jenny) never get guessed between.
const MIN_SCORE = 0.6;
const SHORT_NAME_MIN_SCORE = 0.8; // members of 5 characters or fewer
const MIN_LEAD = 0.08;
// At or above this, a corrected name is shown without a warning.
const CONFIDENT_SCORE = 0.8;

// Hand-picked aliases (lib/nameAliases.js): a reading that is the alias, or
// ends with it, maps straight to that member.
const ALIASES = Object.entries(NAME_ALIASES)
  .map(([alias, target]) => ({ key: nameKey(alias), target }))
  .filter((a) => [...a.key].length >= 4); // shorter ones would match by accident
function findAlias(reads) {
  for (const r of reads) {
    const hit = ALIASES.find((a) => r.key === a.key || r.key.endsWith(a.key));
    if (hit) return { target: hit.target, text: r.text };
  }
  return null;
}

/**
 * @param {Array<{name: string, color: string, uncertain: boolean}>} readings  OCR output
 * @param {string[]} roster  known member names
 * @returns {Array<{name: string, color: string, readAs: string, status: 'exact'|'corrected'|'unknown', confident: boolean}>}
 *   deduped (two readings snapping to one member count once), sorted by name
 */
function matchToRoster(readings, roster) {
  const members = [];
  const seen = new Set();
  for (const name of roster || []) {
    const key = nameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    members.push({ name: String(name).trim(), key, tail: latinTail(name) });
  }
  const byKey = new Map(members.map((m) => [m.key, m]));

  const out = new Map();
  for (const reading of readings) {
    // The OCR may hand over several readings of one nameplate (different
    // settings get different names right). The main reading can make any
    // match. The extra readings are held to a higher bar -- with six
    // readings per nameplate, one of them resembling *some* member by
    // chance is likely -- so they only count when 3+ characters long and
    // only for close matches, never for a ⚠️ guess.
    const reads = [reading.name, ...(reading.alternatives || [])]
      .map((text, i) => ({
        text,
        key: nameKey(text),
        tail: latinTail(text),
        dashFramed: /^[-─—–一ㅡ_=~]/u.test(text) && /[-─—–一ㅡ_=~]$/u.test(text),
        main: i === 0,
      }))
      .filter((r) => r.key && (r.main || [...r.key].length >= 3));
    const readScore = (r, m) => {
      const s = score(r, m);
      return r.main || s >= CONFIDENT_SCORE ? s : 0;
    };

    let result;
    const exactRead = reads.find((r) => byKey.has(r.key));
    const aliasHit = !exactRead && findAlias(reads);
    if (exactRead) {
      result = { name: byKey.get(exactRead.key).name, status: 'exact', confident: true, via: exactRead.text };
    } else if (aliasHit) {
      // Use the roster's own spelling of the target when it's on the list.
      const target = byKey.get(nameKey(aliasHit.target));
      result = { name: target ? target.name : aliasHit.target, status: 'exact', confident: true, via: aliasHit.text };
    } else {
      // Per member, its best score over all readings; then the runner-up
      // check is between members, not between readings of one member.
      let best = null, bestScore = 0, secondScore = 0, via = null;
      for (const m of members) {
        let s = 0, sVia = null;
        for (const r of reads) {
          const rs = readScore(r, m);
          if (rs > s) [s, sVia] = [rs, r.text];
        }
        if (s > bestScore) {
          secondScore = bestScore;
          [bestScore, best, via] = [s, m, sVia];
        } else if (s > secondScore) {
          secondScore = s;
        }
      }
      // Short names need a closer match: one wrong letter in "hey" is a
      // third of the name, and short junk readings (EY, itor) otherwise
      // land on short members (・hey・, STORM).
      const minScore = [...best?.key || ''].length <= 5 ? SHORT_NAME_MIN_SCORE : MIN_SCORE;
      if (best && bestScore >= minScore && bestScore - secondScore >= MIN_LEAD) {
        result = { name: best.name, status: 'corrected', confident: bestScore >= CONFIDENT_SCORE, via };
      } else {
        result = { name: reading.name, status: 'unknown', confident: false, via: reading.name };
      }
    }
    const key = nameKey(result.name);
    const existing = out.get(key);
    // Keep the most trustworthy sighting when two readings land on one name.
    const rank = (r) => (r.status === 'exact' ? 2 : r.confident ? 1 : 0);
    if (!existing || rank(result) > rank(existing)) out.set(key, { ...result, color: reading.color, readAs: reading.name });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

module.exports = { matchToRoster, nameKey, similarity };
