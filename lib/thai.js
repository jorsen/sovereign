// Thai text from the game (a Thai-language client): loot lists, boss names.
// Shared by the loot reader (lootOcr.js), the item matcher (lootMatch.js)
// and boss lookup (bosses.js).

const THAI = /[฀-๿]/;
const hasThai = (s) => THAI.test(String(s || ''));

// Thai text reduced to what OCR reads reliably, for comparing: tone marks
// and the other small marks above letters go (OCR swaps or drops them:
// "จู่" read "จู๋", "ชิ้น" read "ชิน", "น้ำ" read "นํา"), the vowel ำ becomes
// า (OCR splits it into ํ + า), and everything that isn't a Thai letter
// (spaces, Latin, digits, symbols) goes.
function thaiKey(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/ำ/g, 'า')
    .replace(/[็-๎]/g, '')
    .replace(/[^ก-ๆ]/g, '');
}

// Edit distance between `fragment` and the best-matching stretch of `text`
// -- skipping the start or end of `text` is free (names get cut off, and a
// boss name sits inside a longer cell).
function substringDistance(fragment, text) {
  const f = [...fragment], n = [...text];
  let prev = new Array(n.length + 1).fill(0);
  for (let i = 1; i <= f.length; i++) {
    const cur = [i];
    for (let j = 1; j <= n.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (f[i - 1] === n[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.min(...prev);
}

module.exports = { hasThai, thaiKey, substringDistance };
