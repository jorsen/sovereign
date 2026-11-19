// Snaps OCR'd attendance names onto known member names (the Growth Rate
// list), so "IicyFraith" becomes "JuicyFruit" and the posted list uses the
// exact spelling the site already has.
//
// Pure functions, no database: the caller passes the roster in.

const { NAME_ALIASES } = require('./nameAliases');

// Look-alike letters (Cyrillic/Greek/small caps) mapped to the Latin letter
// they read as -- same table as NAME_LOOKALIKES in lib/app.js (keep in sync).
const NAME_LOOKALIKES = {"а":"a","в":"b","с":"c","ԁ":"d","е":"e","ё":"e","һ":"h","н":"h","і":"i","ї":"i","ј":"j","к":"k","ӏ":"l","м":"m","п":"n","о":"o","р":"p","ԛ":"q","г":"r","я":"r","ѕ":"s","т":"t","у":"y","ў":"y","х":"x","ь":"b","ч":"4","з":"3","л":"n","и":"n","ц":"u","ш":"w","щ":"w","д":"a","ф":"o","ж":"x","α":"a","β":"b","γ":"y","δ":"d","ε":"e","η":"n","ι":"i","κ":"k","μ":"u","ν":"v","ο":"o","ρ":"p","σ":"o","τ":"t","υ":"u","χ":"x","ω":"w","ʀ":"r","ɪ":"i","ʏ":"y","ᴀ":"a","ʙ":"b","ᴄ":"c","ᴅ":"d","ᴇ":"e","ɢ":"g","ʜ":"h","ᴊ":"j","ᴋ":"k","ʟ":"l","ᴍ":"m","ɴ":"n","ᴏ":"o","ᴘ":"p","ꜱ":"s","ᴛ":"t","ᴜ":"u","ᴠ":"v","ᴡ":"w","ᴢ":"z"};

// Dedupe/compare key: letters and digits only, lowercased, NFKC-folded.
// Stylized spellings fold to what OCR reads: accents come off Latin letters
// (BÁDtRiP -> badtrip, AyaNínna -> ayaninna, Bazô -> bazo) and look-alike
// letters become the Latin ones. Only for comparing -- the saved name is
// always the member's exact spelling from the database.
function nameKey(name) {
  let out = '';
  for (const ch of String(name || '').normalize('NFKC').toLowerCase()) {
    const c = NAME_LOOKALIKES[ch] || ch;
    out += /\p{Script=Latin}/u.test(c) ? c.normalize('NFD').replace(/\p{M}/gu, '') : c;
  }
  return out.replace(/[^\p{L}\p{N}]/gu, '');
}

// The Latin part of a guild-tag name: 자본丶Suszane -> suszane. OCR mangles
// the Korean/Chinese prefix far more often than the Latin part, so this is
// compared on its own too.
function latinTail(name) {
  const m = String(name || '').normalize('NFKC').match(/^[^A-Za-z0-9]*?[\p{Script=Hangul}\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}][^A-Za-z0-9]*([A-Za-z0-9].*)$/u);
  return m ? nameKey(m[1]) : null;
}

// Letters Tesseract mixes up on this font; swapping one for another costs
// half an edit. Groups may overlap (t is like f, and also like i): every
// pair within a group counts. "br" and "ti" are from real reads: BÁDtRiP's
// name tag came out as "RADiRIP"; y read as v in AyaNínna ("AvaNinaa").
const LOOKALIKES = ['il1|j!', 'o0', 's5', 'b8', 'z2', 'g9q', 'uvy', 'ce', 'ft', 'nh', 'xk', 'br', 'ti'];
const LOOKALIKE_PAIRS = new Set();
for (const group of LOOKALIKES) for (const a of group) for (const b of group) if (a !== b) LOOKALIKE_PAIRS.add(a + b);
function substitutionCost(a, b) {
  if (a === b) return 0;
  return LOOKALIKE_PAIRS.has(a + b) ? 0.5 : 1;
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
const DIGIT_LOOKALIKES = { o: '0', d: '0', i: '1', l: '1', t: '1', j: '1', z: '2', e: '3', a: '4', h: '4', s: '5', g: '6', b: '8', q: '9', '|': '1', '!': '1' };
// Dash-like characters OCR produces around a number name: ASCII and
// box-drawing dashes, CJK 一, and the Korean ㅡ / ᅳ (they look identical).
const DASHES = '-─—–一ㅡᅳ_=~';
const DASH_START = new RegExp(`^[${DASHES}]`, 'u');
const DASH_END = new RegExp(`[${DASHES}]$`, 'u');
// A reading as digits: dashes and spaces dropped, look-alikes turned into
// digits -- from the raw text, since "|" (a misread 1) isn't in the key.
function asDigits(text) {
  return [...String(text).toLowerCase()]
    .filter((ch) => !DASHES.includes(ch) && !/\s/.test(ch))
    .map((ch) => DIGIT_LOOKALIKES[ch] || ch)
    .join('');
}

// Best of: whole name vs whole name, and Latin part vs Latin part (or vs
// the whole other name, for when only one side carries the guild tag).
// Matches made only on the Latin part count a little less.
function score(read, member) {
  let best = similarity(read.key, member.key);
  if (read.dashFramed && member.digits) {
    const digits = asDigits(read.text);
    best = Math.max(best, similarity(digits, member.digits) * 0.9);
    // A dash-framed number with a digit lost ("—4—" for ─41─) still points
    // at the number name containing it. If several number names contain
    // it, the runner-up check leaves it unmatched.
    if (/^\d+$/.test(digits) && member.digits.includes(digits)) best = Math.max(best, 0.8);
  }
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

// Looser second pass for a reading nothing matched: the closest known name
// wins if it's at least 60% right (real misreads seen score 0.63+; on
// blurry captures unrelated names reached 0.5-0.57) and clearly ahead of
// the runner-up. Only the main reading counts here, only readings of 4+
// characters -- shorter ones are usually junk -- and never for short
// member names (5 characters or fewer), where a few junk letters land on
// someone by chance ("-ARAM" -> RaM).
const CLOSEST_MIN_SCORE = 0.6;
const CLOSEST_SHORT_NAME_MIN_SCORE = Infinity; // short names: normal matching only
const CLOSEST_MIN_LEAD = 0.12;
function closestName(main, members) {
  if (!main || [...main.key].length < 4) return null;
  let best = null, bestScore = 0, secondScore = 0;
  for (const m of members) {
    const s = score(main, m);
    if (s > bestScore) [secondScore, bestScore, best] = [bestScore, s, m];
    else if (s > secondScore) secondScore = s;
  }
  if (!best) return null;
  const minScore = [...best.key].length <= 5 ? CLOSEST_SHORT_NAME_MIN_SCORE : CLOSEST_MIN_SCORE;
  return bestScore >= minScore && bestScore - secondScore >= CLOSEST_MIN_LEAD ? best : null;
}

// A name cut off by something in front of it (an icon over "ST" leaves
// "ORM" / "TORM" of STORM) or at the screen edge: a reading that is the
// start or the end of exactly one member's name, covering at least 60% of
// it. Uses the Latin letters at the reading's end/start, since junk in
// front ("이“ORM") is common. Main reading, plus extra readings several OCR
// settings agreed on ("ORM" when the main one was just "RM") -- one-off
// extra readings are scraps that would hit some short name by chance
// ("aly" -> Alyツ). Always a ⚠️ guess.
const CUT_MIN_COVERAGE = 0.6;
function cutOffName(reads, members) {
  const hits = new Set();
  for (const r of reads) {
    const latin = nameKey(r.text).match(/^[a-z0-9]+|[a-z0-9]+$/g) || [];
    for (const piece of latin) {
      if (piece.length < 3) continue;
      for (const m of members) {
        if ((m.key.startsWith(piece) || m.key.endsWith(piece)) && piece.length / [...m.key].length >= CUT_MIN_COVERAGE && piece !== m.key) hits.add(m);
      }
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
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
    // Number names, however their dashes are written (─41─, -41-, 一41一):
    // just the digits, for comparing against dash-framed readings.
    const bare = [...String(name)].filter((ch) => !DASHES.includes(ch) && !/\s/.test(ch)).join('');
    const digits = /^\d+$/.test(bare) ? bare : null;
    members.push({ name: String(name).trim(), key, tail: latinTail(name), digits });
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
        // Framed by a dash on at least one side (the other is often cut off).
        dashFramed: (DASH_START.test(text) || DASH_END.test(text)) && /\d/.test(asDigits(text)),
        main: i === 0,
        // Agreed on by several OCR settings (attendanceOcr.js `strong`).
        strong: i === 0 || (reading.strong || []).includes(text),
      }))
      .filter((r) => r.key && (r.main || [...r.key].length >= 3));
    const readScore = (r, m) => {
      const s = score(r, m);
      // Extra readings: close matches only, and exact ones for short member
      // names -- "Pars" (a misread of junk) scored 0.8 against ・PARIS・.
      if (r.main) return s;
      if ([...m.key].length <= 5) return r.key === m.key ? s : 0;
      return s >= CONFIDENT_SCORE ? s : 0;
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
        // Still no match: fall back to the closest known name, as long as
        // it's clearly the closest. Always a ⚠️ guess, shown with what OCR
        // read, so it can be checked.
        const closest = closestName(reads.find((r) => r.main), members) || cutOffName(reads.filter((r) => r.strong), members);
        result = closest
          ? { name: closest.name, status: 'corrected', confident: false, via: reading.name }
          : { name: reading.name, status: 'unknown', confident: false, via: reading.name };
      }
    }
    const key = nameKey(result.name);
    const existing = out.get(key);
    // Keep the most trustworthy sighting when two readings land on one name.
    const rank = (r) => (r.status === 'exact' ? 2 : r.confident ? 1 : 0);
    if (!existing || rank(result) > rank(existing)) {
      out.set(key, { ...result, color: reading.color, readAs: reading.name, guessReads: existing?.guessReads || new Set() });
    }
    // Two *different* misreads (another size, another screenshot) that both
    // come out as the same member confirm the guess: no ⚠️. The same garbled
    // text twice is one piece of evidence, so it doesn't count.
    const kept = out.get(key);
    if (result.status === 'corrected' && !result.confident) {
      kept.guessReads.add(nameKey(reading.name));
      if (kept.status === 'corrected' && kept.guessReads.size >= 2) kept.confident = true;
    }
  }
  for (const r of out.values()) delete r.guessReads;
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

module.exports = { matchToRoster, nameKey, similarity };
