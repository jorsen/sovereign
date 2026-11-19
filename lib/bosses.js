// Boss names for the attendance trackers -- the site's Log Attendance
// dropdowns (lib/app.js) and the Discord attendance scan both read them
// from here, so a boss added once shows up in both.

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
};

// Schedules whose boss names, typed in the Discord attendance channel next
// to screenshots, trigger a scan. BF4 Boss isn't one: its only "name" is
// the generic "BF4 Boss".
const SCANNABLE_SCHEDULES = ['world_boss', 'balthazard'];

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
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
function findBossInText(text) {
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

module.exports = { WORLD_BOSS_NAMES, WORLD_BOSS_SCHEDULES, findBossInText, bossTitle };
