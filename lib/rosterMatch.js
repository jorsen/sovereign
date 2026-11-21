// Snaps OCR'd attendance names onto known member names (the Growth Rate
// list), so "IicyFraith" becomes "JuicyFruit" and the posted list uses the
// exact spelling the site already has.
//
// Pure functions, no database: the caller passes the roster in.

const { NAME_ALIASES } = require('./nameAliases');

// Look-alike letters (Cyrillic/Greek/small caps) mapped to the Latin letter
// they read as -- same table as NAME_LOOKALIKES in lib/app.js (keep in sync),
// plus メ/乂 -> x, for OCR only (the game draws メ like an X: ・ILLESTメ is read
// as "LLEST X"); the site must not treat Sphinメ and Sphinx as one name.
const NAME_LOOKALIKES = {"а":"a","в":"b","с":"c","ԁ":"d","е":"e","ё":"e","һ":"h","н":"h","і":"i","ї":"i","ј":"j","к":"k","ӏ":"l","м":"m","п":"n","о":"o","р":"p","ԛ":"q","г":"r","я":"r","ѕ":"s","т":"t","у":"y","ў":"y","х":"x","ь":"b","ч":"4","з":"3","л":"n","и":"n","ц":"u","ш":"w","щ":"w","д":"a","ф":"o","ж":"x","α":"a","β":"b","γ":"y","δ":"d","ε":"e","η":"n","ι":"i","κ":"k","μ":"u","ν":"v","ο":"o","ρ":"p","σ":"o","τ":"t","υ":"u","χ":"x","ω":"w","ʀ":"r","ɪ":"i","ʏ":"y","ᴀ":"a","ʙ":"b","ᴄ":"c","ᴅ":"d","ᴇ":"e","ɢ":"g","ʜ":"h","ᴊ":"j","ᴋ":"k","ʟ":"l","ᴍ":"m","ɴ":"n","ᴏ":"o","ᴘ":"p","ꜱ":"s","ᴛ":"t","ᴜ":"u","ᴠ":"v","ᴡ":"w","ᴢ":"z","メ":"x","乂":"x"};

// Dedupe/compare key: letters and digits only, lowercased, NFKC-folded.
// Stylized spellings fold to what OCR reads: accents come off Latin letters
// (BÁDtRiP -> badtrip, AyaNínna -> ayaninna, Bazô -> bazo) and look-alike
// letters become the Latin ones. Only for comparing -- the saved name is
// always the member's exact spelling from the database.
function nameKey(name) {
  let out = '';
  for (const ch of String(name || '').normalize('NFKC').toLowerCase()) {
    const c = NAME_LOOKALIKES[ch] || ch;
    // Accents off Latin letters; voicing marks off kana (゛゜ are a pixel or
    // two on small text: とらふ was read as とらぶ).
    out += /[\p{Script=Latin}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c) ? c.normalize('NFD').replace(/\p{M}/gu, '') : c;
  }
  return out.replace(/[^\p{L}\p{N}]/gu, '');
}

// The Latin part of a decorated name: 자본丶Suszane -> suszane, คnNikaツ ->
// nnika. OCR mangles Korean/Chinese/Thai/Japanese characters far more often
// than the Latin part, so that is compared on its own too: the longest run
// of Latin letters and digits, when the name has other letters around it.
// For OCR readings, only a Latin part after a CJK/Thai prefix counts (as
// the members' guild tags look): any Latin scrap of junk ("i+;i,AN了" ->
// "iian") would otherwise vote for a member (Jiian).
function readingTail(text) {
  const m = String(text || '').normalize('NFKC').match(/^[^A-Za-z0-9]*?[\p{Script=Hangul}\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Thai}][^A-Za-z0-9]*([A-Za-z0-9].*)$/u);
  return m ? nameKey(m[1]) : null;
}
function latinTail(name) {
  const key = nameKey(name);
  if (!/[^a-z0-9]/.test(key)) return null;
  const longest = (key.match(/[a-z0-9]+/g) || []).sort((a, b) => b.length - a.length)[0];
  return longest && longest.length >= 3 ? longest : null;
}

// Letters Tesseract mixes up on this font; swapping one for another costs
// half an edit. Groups may overlap (t is like f, and also like i): every
// pair within a group counts. "br" and "ti" are from real reads: BÁDtRiP's
// name tag came out as "RADiRIP"; y read as v in AyaNínna ("AvaNinaa").
const LOOKALIKES = ['il1|j!', 'o0', 's5', 'b8', 'z2', 'g9q', 'uvy', 'ce', 'ae', 'ft', 'nh', 'xk', 'br', 'ti'];
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

// Just the Han characters of a name or reading, when it has 3+ of them.
function hanPart(text) {
  const han = (String(text || '').match(/\p{Script=Han}/gu) || []).filter((ch) => !DASHES.includes(ch)).join('');
  return [...han].length >= 3 ? han : null;
}

// Digits between two dashes anywhere in a reading (2+ digits, both dashes
// needed -- so it's a framed number, not a stray digit in junk).
const FRAMED_NUMBER = new RegExp(`[${DASHES}]([^${DASHES}]{2,4})[${DASHES}]`, 'gu');
function framedNumber(text) {
  for (const m of String(text).matchAll(FRAMED_NUMBER)) {
    const digits = asDigits(m[1]);
    // At least one real digit: letters alone between dashes ("一ae一") would
    // turn into a number through the look-alike table.
    if (/\d/.test(m[1]) && /^\d{2,}$/.test(digits)) return digits;
  }
  return null;
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
  // Chinese characters on their own: the Chinese reader can't read the Thai
  // or Latin bits around them (殺豬小隊ฅ金元寶ฅ read as "殺豬小隊@金元容").
  if (read.han && member.han) best = Math.max(best, similarity(read.han, member.han) * 0.95);
  // The exact number, dash-framed, inside a longer reading ("ee一41一").
  if (member.digits && read.framedDigits === member.digits) best = Math.max(best, 0.9);
  const pairs = [
    [read.tail, member.tail],
    [read.tail, member.key],
    [read.key, member.tail],
  ];
  for (const [a, b] of pairs) {
    if (a && b && Math.min([...a].length, [...b].length) >= 4) best = Math.max(best, similarity(a, b) * 0.95);
  }
  // Trainer: misreadings of this member confirmed before ("RADiRIP" for
  // BÁDtRiP) count as extra spellings, so a similar misreading scores high.
  // Only near-repeats of it, though -- a learned scrap like "alle" must not
  // pull in any loosely similar junk.
  for (const learned of member.learned || []) {
    const s = similarity(read.key, learned);
    if (s >= LEARNED_MIN_SIMILARITY) best = Math.max(best, s * 0.95);
  }
  // Trainer: a reading that was matched to this member and then removed
  // from the record (an admin's fix, or a rescan) never matches them again.
  if (member.rejected?.has(read.key)) return 0;
  return best;
}

// Trainer, attendance history: how often each member attended World Boss
// kills lately (0-1, from loadMatchingContext). Regulars (≥ 40% of kills)
// need a slightly less clear reading for a guessed match; members with no
// attendance at all lately need a clearer one. Exact reads are unaffected.
const REGULAR_RATE = 0.4;
function historyAdjust(member) {
  if (member.attendRate == null) return 0;
  if (member.attendRate >= REGULAR_RATE) return -0.05;
  if (member.attendRate === 0) return 0.08;
  return 0;
}

// Trainer: a misreading counts as learned once it held up on this many
// different kills, and helps only readings at least this close to it.
const LEARN_MIN_KILLS = 2;
const LEARNED_MIN_SIMILARITY = 0.8;

// Below MIN_SCORE a reading is left as-is (probably someone not on the
// list yet). A match also has to beat the runner-up clearly, so two
// similar roster names (Jenn / Jenny) never get guessed between.
const MIN_SCORE = 0.6;
const SHORT_NAME_MIN_SCORE = 0.8; // members of 5 characters or fewer
// "Short" counts a Han/Hangul/Kana character as two: 龜懶趴火欸 (5 Han) holds
// far more than "Jenn" and needs no extra-strict rules -- a scrap of junk
// doesn't land on five Chinese characters by chance.
function isShortName(key) {
  let n = 0;
  // (一 in 一41一 is a dash, not a word: it counts as one.)
  for (const ch of key) n += !DASHES.includes(ch) && /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch) ? 2 : 1;
  return n <= 5;
}
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
  // A decorated name is as short as its Latin part, which is what a junk
  // reading gets compared to: 卍Allen卍 is "allen" -- background behind a
  // see-through panel read "Fallin" and was guessed as him.
  const short = isShortName(best.key) || (best.tail && [...best.tail].length <= 5);
  const minScore = (short ? CLOSEST_SHORT_NAME_MIN_SCORE : CLOSEST_MIN_SCORE) + historyAdjust(best);
  return bestScore >= minScore && bestScore - secondScore >= CLOSEST_MIN_LEAD ? best : null;
}

// "Check it many times": every different reading of one nameplate (6
// settings, 2 sizes, and for unclear ones closer zooms and the original
// pixels) that is at least 70% like a member is a vote for them. The member
// with the most votes wins if no one else has as many. 2 votes add a name
// nothing else could place; 3+ make a guess sure.
const VOTE_SCORE = 0.7;
const ADD_VOTES = 2;
const SURE_VOTES = 3;
function voteFor(reads, members) {
  const usable = reads.filter((r) => [...r.key].length >= 3);
  let best = null, bestVotes = 0, secondVotes = 0;
  for (const m of members) {
    // Short names (Chan) take no votes: "Chane" and "Chun" off a Chunksssss
    // plate are each 70%+ like them by chance.
    if (isShortName(m.key)) continue;
    let votes = 0;
    for (const r of usable) if (score(r, m) >= VOTE_SCORE) votes++;
    if (votes > bestVotes) [secondVotes, bestVotes, best] = [bestVotes, votes, m];
    else if (votes > secondVotes) secondVotes = votes;
  }
  return best && bestVotes > secondVotes ? { member: best, votes: bestVotes } : null;
}

// Long Chinese names: each reading of a small Han nameplate gets a few
// characters wrong, but different ones ("品金香都漲的浴市香", "凡金香都漲妳的浴市得",
// "變金得都沒妳的痊出香" for 鬱金香都沒妳的浴巾香). Together they cover most of
// the name: a member whose Han characters are 75%+ covered (in order) by 2+
// readings, each half right on its own, and clearly more than anyone else.
const HAN_MIN_CHARS = 5;
const HAN_COVERAGE = 0.75;
const HAN_MIN_LEAD = 0.2;
function lcsPositions(a, b) {
  const A = [...a], B = [...b];
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const pos = [];
  for (let i = A.length, j = B.length; i && j;) {
    if (A[i - 1] === B[j - 1]) { pos.push(j - 1); i--; j--; } else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--;
  }
  return pos; // positions in b
}
function hanConsensus(reads, members) {
  const hanReads = [...new Set(reads.map((r) => r.han).filter(Boolean))];
  if (hanReads.length < 2) return null;
  const ranked = members
    .filter((m) => m.han && [...m.han].length >= HAN_MIN_CHARS)
    .map((m) => {
      const len = [...m.han].length;
      const covered = new Set();
      let used = 0;
      for (const h of hanReads) {
        const pos = lcsPositions(h, m.han);
        if (pos.length / len < 0.5) continue;
        used++;
        pos.forEach((p) => covered.add(p));
      }
      return { m, coverage: used >= 2 ? covered.size / len : 0 };
    })
    .sort((a, b) => b.coverage - a.coverage);
  const [best, next] = ranked;
  if (!best || best.coverage < HAN_COVERAGE || best.coverage - (next?.coverage || 0) < HAN_MIN_LEAD) return null;
  return best.m;
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
 * @param {{ memory?: Array<{ readingKey: string, member: string, good: number, bad: number }>,
 *           attendRate?: Map<string, number> }} [trainer]  what the bot has learned
 *   (loadMatchingContext): past misreadings and whether they were right, and
 *   each member's recent attendance rate, keyed by lowercased name
 * @returns {Array<{name: string, color: string, readAs: string, status: 'exact'|'corrected'|'unknown', confident: boolean}>}
 *   deduped (two readings snapping to one member count once), sorted by name
 */
function matchToRoster(readings, roster, trainer = {}) {
  // Trainer memory per member: readings confirmed for them (more times
  // right than wrong) and readings proven wrong for them.
  const learnedFor = new Map();
  const rejectedFor = new Map();
  const confirmedReading = new Map(); // reading key -> member name, when unambiguous
  for (const m of trainer.memory || []) {
    const memberKey = nameKey(m.member);
    // good/bad count different kills. One kill isn't proof: a wrong guess
    // nobody has fixed yet is still "on the record" too, and rescanning that
    // kill would otherwise confirm the mistake with itself (卍Allen卍 from
    // "Yall는"). So a reading is learned once it held up on 2+ kills.
    if (m.good >= LEARN_MIN_KILLS && m.good > m.bad && [...m.readingKey].length >= 4) {
      if (!learnedFor.has(memberKey)) learnedFor.set(memberKey, []);
      learnedFor.get(memberKey).push(m.readingKey);
      const prev = confirmedReading.get(m.readingKey);
      confirmedReading.set(m.readingKey, prev && nameKey(prev) !== memberKey ? null : m.member);
    } else if (m.bad >= LEARN_MIN_KILLS && m.bad > m.good) {
      // Same the other way: dropped from one kill's record isn't proof of a
      // misread either -- a rescan of blurry copies dropped Bяielle ("breele")
      // and that blocked her correct reading from then on.
      if (!rejectedFor.has(memberKey)) rejectedFor.set(memberKey, new Set());
      rejectedFor.get(memberKey).add(m.readingKey);
    }
  }

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
    members.push({
      name: String(name).trim(),
      key,
      tail: latinTail(name),
      han: hanPart(name),
      digits,
      learned: learnedFor.get(key) || [],
      rejected: rejectedFor.get(key),
      attendRate: trainer.attendRate ? trainer.attendRate.get(String(name).trim().toLowerCase()) ?? 0 : null,
    });
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
        tail: readingTail(text),
        // Framed by a dash on at least one side (the other is often cut off).
        dashFramed: (DASH_START.test(text) || DASH_END.test(text)) && /\d/.test(asDigits(text)),
        // A whole number framed by dashes somewhere inside the reading, with
        // junk around it: "ee一41一" -> 41.
        framedDigits: framedNumber(text),
        han: hanPart(text),
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
      if (m.digits && r.framedDigits === m.digits) return s;
      if (isShortName(m.key)) return r.key === m.key ? s : 0;
      return s >= CONFIDENT_SCORE ? s : 0;
    };

    let result;
    // An exact spelling counts -- but for a name of 3 letters or fewer, only
    // from the main reading or one several settings agree on: one stray
    // side reading of a blur ("Re Na" ... "hey") made ・hey・ a sure attendee.
    const exactRead = reads.find((r) => byKey.has(r.key) && (r.strong || [...r.key].length > 3));
    const aliasHit = !exactRead && findAlias(reads);
    // Trainer: this exact misreading was saved for one member before and
    // the record still has them -- the same blurry nameplate again.
    const learnedRead = !exactRead && !aliasHit && reads.find((r) => r.strong && [...r.key].length >= 4 && confirmedReading.get(r.key) && byKey.has(nameKey(confirmedReading.get(r.key))));
    if (exactRead) {
      result = { name: byKey.get(exactRead.key).name, status: 'exact', confident: true, via: exactRead.text };
    } else if (learnedRead) {
      result = { name: byKey.get(nameKey(confirmedReading.get(learnedRead.key))).name, status: 'corrected', confident: true, via: learnedRead.text };
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
      // 3 letters or fewer (・hey・): only an exact read. One look-alike letter is
      // a third of the name ("Hay" scored 0.83 against hey).
      const tiny = best && [...best.key].length <= 3;
      // A decorated name counts as short when its Latin part is (卍Allen卍 ->
      // "allen"): junk ("Fallin") scores against that part alone.
      const short = isShortName(best?.key || '') || Boolean(best?.tail && [...best.tail].length <= 5);
      const minScore = tiny ? Infinity : (short ? SHORT_NAME_MIN_SCORE : MIN_SCORE) + (best ? historyAdjust(best) : 0);
      const vote = voteFor(reads, members);
      if (best && bestScore >= minScore && bestScore - secondScore >= MIN_LEAD) {
        // Several readings agreeing on this member makes the guess sure.
        const agreed = vote && vote.member === best && vote.votes >= SURE_VOTES;
        result = { name: best.name, status: 'corrected', confident: bestScore >= CONFIDENT_SCORE || agreed, via };
      } else if (vote && vote.votes >= ADD_VOTES) {
        // No single reading was close enough, but several separate readings
        // (other zoom levels, the original pixels) each point to the same
        // member and to no one else as much: that's them.
        result = { name: vote.member.name, status: 'corrected', confident: vote.votes >= SURE_VOTES, via: reading.name };
      } else if (hanConsensus(reads, members)) {
        result = { name: hanConsensus(reads, members).name, status: 'corrected', confident: true, via: reading.name };
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
    // A nameplate found only through the dim-blue fallback (attendanceOcr):
    // clear matches only -- dark-blue junk shapes ("ALY") mustn't become a
    // guessed member (Alyツ).
    if (reading.dim && result.status === 'corrected' && !result.confident) {
      result = { name: reading.name, status: 'unknown', confident: false, via: reading.name };
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
