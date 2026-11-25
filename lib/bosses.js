// Boss names for the attendance trackers -- the site's Log Attendance
// dropdowns (lib/app.js) and the Discord attendance scan both read them
// from here, so a boss added once shows up in both.
const { hasThai, hasHan, keyFor, substringDistance } = require('./gameText');

const WORLD_BOSS_NAMES = [
  'Ruined Knight',
  'Kafka',
  'Stormid of Onrush',
  'Hakir',
  'Awakened Panderre',
  'Damiross',
  'Tandallon',
  'Melville',
  'Ducas / Dergio',
];

// A "schedule" is an independent boss-attendance tracker -- its own
// calendar, attendance log, and loot -- sharing the same tables/routes as
// the original World Boss Attendance feature via a `schedule` column,
// instead of duplicating every table/route/UI function for each one.
// Adding a new tracker is just adding an entry here (plus its own boss
// name list) rather than copy-pasting the feature.
const WORLD_BOSS_SCHEDULES = {
  world_boss: { label: 'World Boss', bossNames: WORLD_BOSS_NAMES },
  bf4: { label: 'BF4 Boss', bossNames: ['BF4 Boss'] },
  balthazard: { label: 'Balthazard', bossNames: ['Balthazard'] },
  aegis: { label: 'Aegis', bossNames: ['Aegis'] },
};

// Schedules whose boss names, typed in the Discord attendance channel next
// to screenshots, trigger a scan. BF4 Boss isn't one: its only "name" is
// the generic "BF4 Boss".
const SCANNABLE_SCHEDULES = ['world_boss', 'balthazard', 'aegis'];

// Edit distance where swapping two neighboring letters ("kafak" for
// "kafka") counts as one typo, not two.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const words = (text) => String(text || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];

// Each boss is recognized by any of its distinctive words, so "Ducas",
// "dergio", "panderre" or "stormid" alone are enough. One typo is allowed
// in words of 5+ letters, two in words of 8+ ("baltazard", "tandalon").
const BOSS_WORDS = SCANNABLE_SCHEDULES.flatMap((schedule) =>
  WORLD_BOSS_SCHEDULES[schedule].bossNames.flatMap((boss) =>
    words(boss)
      .filter((w) => w.length >= 4 && w !== 'boss')
      .map((word) => ({ word, boss, schedule }))
  )
);

/**
 * Finds the boss a message is about, e.g. "kafka 88/96" -> Kafka.
 * @returns {{ schedule: string, label: string, boss: string } | null}
 *   the first boss mentioned in the text, or null if none is
 */
// Other names members type for a boss: "88/96" (the two bosses' levels) is
// Ducas / Dergio -- also as "88 / 96", "88-96", "88|96". A lone 88 or 96
// doesn't count (numbers are too common in chat).
const BOSS_ALIASES = [
  { pattern: /(?<!\d)88\s*[/\\|-]\s*96(?!\d)/, schedule: 'world_boss', boss: 'Ducas / Dergio' },
];

// Boss names as a game in another language shows them (loot lists, and what
// members type): Thai ('th') and Traditional Chinese ('zh'). Add the others
// as they turn up, spelled as the game does (Thai tone marks don't matter).
// A short form members type on its own can be listed too ("潘代爾").
// OCR slips allowed: ~15% of the letters for Thai, 1 in 5 characters for
// Chinese (none in a name under 5).
const FOREIGN_BOSS_NAMES = [
  { lang: 'th', name: 'สตอร์มิดจู่โจมรุนแรง', schedule: 'world_boss', boss: 'Stormid of Onrush' },
  { lang: 'th', name: 'ฮาคีร์', schedule: 'world_boss', boss: 'Hakir' },
  { lang: 'zh', name: '覺醒的潘代爾', schedule: 'world_boss', boss: 'Awakened Panderre' },
  { lang: 'zh', name: '潘代爾', schedule: 'world_boss', boss: 'Awakened Panderre' },
  { lang: 'zh', name: '達米羅斯', schedule: 'world_boss', boss: 'Damiross' },
];
const FOREIGN_BOSS_KEYS = FOREIGN_BOSS_NAMES.map((b) => ({ ...b, key: keyFor(b.lang)(b.name) }));
const SLIPS = { th: (n) => Math.floor(n * 0.15), zh: (n) => Math.floor(n / 5) };
function findForeignBoss(text, lang) {
  const key = keyFor(lang)(text);
  if (key.length < (lang === 'zh' ? 2 : 4)) return null;
  let best = null;
  for (const b of FOREIGN_BOSS_KEYS) {
    if (b.lang !== lang) continue;
    const d = substringDistance(b.key, key);
    // The longer name wins a tie: "覺醒的潘代爾" over its short form.
    if (d <= SLIPS[lang](b.key.length) && (!best || d < best.d || (d === best.d && b.key.length > best.b.key.length))) best = { d, b };
  }
  return best ? { schedule: best.b.schedule, label: WORLD_BOSS_SCHEDULES[best.b.schedule].label, boss: best.b.boss } : null;
}

function findBossInText(text) {
  for (const a of BOSS_ALIASES) {
    if (a.pattern.test(String(text || ''))) return { schedule: a.schedule, label: WORLD_BOSS_SCHEDULES[a.schedule].label, boss: a.boss };
  }
  for (const lang of [hasThai(text) && 'th', hasHan(text) && 'zh'].filter(Boolean)) {
    const found = findForeignBoss(text, lang);
    if (found) return found;
  }
  for (const w of words(text)) {
    const allowed = w.length >= 8 ? 2 : w.length >= 5 ? 1 : 0;
    const hit = BOSS_WORDS.find((b) => b.word === w || (allowed && Math.abs(b.word.length - w.length) <= allowed && editDistance(b.word, w) <= allowed));
    if (hit) return { schedule: hit.schedule, label: WORLD_BOSS_SCHEDULES[hit.schedule].label, boss: hit.boss };
  }
  return null;
}

// "World Boss - Kafka", or just "Balthazard" when the boss is the schedule.
function bossTitle({ label, boss }) {
  return label === boss ? boss : `${label} - ${boss}`;
}

// Every boss that can be logged from Discord, in dropdown order -- the
// /attendance boss suggestions and the unknown-boss reply list these.
const SCANNABLE_BOSSES = SCANNABLE_SCHEDULES.flatMap((schedule) =>
  WORLD_BOSS_SCHEDULES[schedule].bossNames.map((boss) => ({ schedule, label: WORLD_BOSS_SCHEDULES[schedule].label, boss }))
);

module.exports = { WORLD_BOSS_NAMES, WORLD_BOSS_SCHEDULES, SCANNABLE_BOSSES, findBossInText, bossTitle };
