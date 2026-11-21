// Reads the in-game loot distribution list (item · "Boss-Player" · guild ·
// "11.20.2026 00:55 (UTC+8)" · ... · Distribute) off a screenshot, with the
// same free, local Tesseract OCR as the nameplate reader. Unlike nameplates
// this is clean UI text on a plain dark background, so a whole-screen read
// works well; the only extra step is the small quantity badge on an item's
// icon ("2" in the corner), read separately.
//
// Pure function of the image: completing cut-off item names and saving are
// done by lootMatch.js / attendanceRecords.js.
const path = require('path');
const sharp = require('sharp');
const { findBossInText } = require('./bosses');

// The boss in a row's text: the name right before the dash of "Boss-Player"
// first -- an item's own name can hold a boss-like word ("...vonia Knights
// Gloves Tandallon-Armezr" was filed under Ruined Knight) -- and only then
// any boss word in the text.
function bossBeforeDash(text) {
  for (const m of String(text || '').matchAll(/([A-Za-z]+)\s*[-—–]/g)) {
    const boss = findBossInText(m[1]);
    if (boss) return boss;
  }
  return null;
}
const bossInRow = (text) => bossBeforeDash(text) || findBossInText(text);

const OCR_DATA_DIR = path.join(__dirname, '..', 'ocr-data');

// "11.20.2026 00:55" -- month.day.year, as the game shows it. The time is
// already the guild's own clock (the list itself says UTC+8). OCR sometimes
// drops the time's colon ("11.19.2026 0625"); such a row is still a row.
const KILL_TIME = /(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):?(\d{2})(?!\d)/;

let workerPromise;
function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker(['eng'], 1, { langPath: OCR_DATA_DIR, gzip: false, cacheMethod: 'none' }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function recognize(png, params) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_char_whitelist: '', preserve_interword_spaces: '1', ...params });
  return (await worker.recognize(png, {}, { blocks: true })).data;
}

const pad = (n) => String(n).padStart(2, '0');

// The quantity badge: a small near-white number in the bottom-right corner
// of the item icon. Rather than trusting fixed coordinates, this looks in
// that corner for bright, digit-sized blobs and reads only those.
async function readQuantityBadge(rgb, W, H, area) {
  const x0 = Math.max(0, Math.round(area.x0)), y0 = Math.max(0, Math.round(area.y0));
  const x1 = Math.min(W - 1, Math.round(area.x1)), y1 = Math.min(H - 1, Math.round(area.y1));
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w < 6 || h < 6) return 1;
  // Bright and colorless (the digit is cream/white; icon art is colored).
  const bright = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * W + (x0 + x)) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      if (Math.min(r, g, b) >= 185 && Math.max(r, g, b) - Math.min(r, g, b) <= 60) bright[y * w + x] = 1;
    }
  }
  // A badge digit has a dark outline: the pixels just around it are almost
  // all dark (4-5% bright measured). Pale icon art in the corner -- the gold
  // filigree of Higher Seal of Advancement, read as a "3" on every Seal row
  // (4 Seals saved as 12) -- sits among more bright art (35-50%).
  const darkRing = (blob) => {
    let n = 0, lit = 0;
    for (let y = blob.y0 - 2; y <= blob.y1 + 2; y++) {
      for (let x = blob.x0 - 2; x <= blob.x1 + 2; x++) {
        if (x >= blob.x0 && x <= blob.x1 && y >= blob.y0 && y <= blob.y1) continue;
        const ax = x0 + x, ay = y0 + y;
        if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
        const i = (ay * W + ax) * 3;
        n++;
        if (Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) >= 140) lit++;
      }
    }
    return !n || lit / n <= 0.2;
  };
  // Connected blobs; keep the digit-sized ones.
  const seen = new Uint8Array(w * h);
  const digits = [];
  const expected = area.digitHeight;
  for (let p = 0; p < w * h; p++) {
    if (!bright[p] || seen[p]) continue;
    const stack = [p];
    seen[p] = 1;
    const blob = { x0: w, y0: h, x1: 0, y1: 0, px: [] };
    while (stack.length) {
      const q = stack.pop();
      const x = q % w, y = (q / w) | 0;
      blob.px.push(q);
      blob.x0 = Math.min(blob.x0, x); blob.x1 = Math.max(blob.x1, x);
      blob.y0 = Math.min(blob.y0, y); blob.y1 = Math.max(blob.y1, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const r = ny * w + nx;
        if (bright[r] && !seen[r]) { seen[r] = 1; stack.push(r); }
      }
    }
    const bh = blob.y1 - blob.y0 + 1, bw = blob.x1 - blob.x0 + 1;
    if (bh >= expected * 0.6 && bh <= expected * 1.5 && bw >= 2 && bw <= expected && darkRing(blob)) digits.push(blob);
  }
  if (!digits.length) return 1;
  const readNumber = async (png, mode) => {
    const res = await recognize(png, { tessedit_pageseg_mode: mode, tessedit_char_whitelist: '0123456789' });
    const n = Number(res.text.trim());
    return Number.isInteger(n) && n >= 2 && n <= 999 && res.confidence >= 50 ? n : null;
  };
  // The digits' softer edge pixels too (lighter grey, still colorless), within
  // a pixel of each digit's box: on its own the bright core of a small "2" is
  // thin and broken, and Tesseract read it or not depending on where it sat.
  const soft = (x, y) => {
    const i = ((y0 + y) * W + (x0 + x)) * 3;
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    return Math.min(r, g, b) >= 140 && Math.max(r, g, b) - Math.min(r, g, b) <= 60;
  };
  for (const d of digits) {
    for (let y = Math.max(0, d.y0 - 1); y <= Math.min(h - 1, d.y1 + 1); y++) {
      for (let x = Math.max(0, d.x0 - 1); x <= Math.min(w - 1, d.x1 + 1); x++) {
        const q = y * w + x;
        if (!bright[q] && soft(x, y)) d.px.push(q);
      }
    }
  }
  // Black digits on white, enlarged, for the OCR: the whole corner first...
  const whole = Buffer.alloc(w * h, 255);
  for (const d of digits) for (const q of d.px) whole[q] = 0;
  const wholePng = await sharp(whole, { raw: { width: w, height: h, channels: 1 } })
    .resize({ width: w * 6, kernel: 'lanczos3' })
    .extend({ top: 24, bottom: 24, left: 24, right: 24, background: '#ffffff' })
    .png()
    .toBuffer();
  const first = await readNumber(wholePng, '7');
  if (first) return first;
  // ...then cut tight around the digits at a fixed size: Tesseract read
  // nothing from a lone "2" at the edge of the corner crop (Kafka's first
  // Frozen Tear ×2).
  const bx0 = Math.max(0, Math.min(...digits.map((d) => d.x0)) - 2), bx1 = Math.min(w - 1, Math.max(...digits.map((d) => d.x1)) + 2);
  const by0 = Math.max(0, Math.min(...digits.map((d) => d.y0)) - 2), by1 = Math.min(h - 1, Math.max(...digits.map((d) => d.y1)) + 2);
  const cw = bx1 - bx0 + 1, ch = by1 - by0 + 1;
  const crop = Buffer.alloc(cw * ch, 255);
  for (const d of digits) for (const q of d.px) crop[(((q / w) | 0) - by0) * cw + (q % w) - bx0] = 0;
  const png = await sharp(crop, { raw: { width: cw, height: ch, channels: 1 } })
    .resize({ height: 60, kernel: 'lanczos3' })
    .extend({ top: 30, bottom: 30, left: 30, right: 30, background: '#ffffff' })
    .png()
    .toBuffer();
  // One digit: single-character mode reads it most reliably; several: a line.
  const modes = digits.length === 1 ? ['10', '7'] : ['7', '8'];
  for (const mode of modes) {
    const n = await readNumber(png, mode);
    if (n) return n;
  }
  return 1;
}

// An item's icon as a tiny picture (6 x 6 colors, as a hex
// string) -- the item names are often cut off ("Enhancement Scroll" could be
// four items), but each item's icon is its own. The middle of the icon only
// (the frame and the quantity badge in its corner are left out), so the
// same item compares alike at any screenshot size or JPEG quality.
const ICON_GRID = 6;
async function iconFingerprint(base, { x0, y0, size }) {
  const W = base.info.width, H = base.info.height;
  const inset = size * 0.18;
  const left = Math.max(0, Math.round(x0 + inset));
  const top = Math.max(0, Math.round(y0 + inset));
  const side = Math.round(size - inset * 2);
  if (side < 8 || left + side > W || top + side > H) return null;
  const px = await sharp(base.data, { raw: base.info })
    .extract({ left, top, width: side, height: side })
    .resize(ICON_GRID, ICON_GRID, { kernel: 'cubic' })
    .raw()
    .toBuffer();
  return px.toString('hex');
}

// Walks left from the text over the row's dark background until it reaches
// the icon's frame: a column where much of the middle band is lighter than
// the background. Returns that column's x, or null.
function findIconRight(base, { fromX, rowMid, iconSize }) {
  const W = base.info.width, H = base.info.height, ch = base.info.channels;
  const y0 = Math.max(0, Math.round(rowMid - iconSize * 0.35));
  const y1 = Math.min(H - 1, Math.round(rowMid + iconSize * 0.35));
  const lum = (x, y) => {
    const i = (y * W + x) * ch;
    return (base.data[i] + base.data[i + 1] + base.data[i + 2]) / 3;
  };
  const colLums = (x) => {
    const out = [];
    for (let y = y0; y <= y1; y++) out.push(lum(x, y));
    return out;
  };
  const start = Math.min(W - 1, Math.round(fromX));
  // Background brightness: just left of the text, the gap is background
  // (or the cut-off text's own dark mask).
  let bg = Infinity;
  for (let x = start; x > start - iconSize * 0.3 && x >= 0; x--) bg = Math.min(bg, median(colLums(x)));
  for (let x = start, gap = 0; x >= Math.max(0, start - iconSize * 1.5); x--) {
    const lums = colLums(x);
    const busy = lums.filter((v) => v > bg + 25).length / lums.length;
    if (busy > 0.6) return gap >= 1 ? x + 1 : null; // need some gap: else it's still text
    if (busy < 0.15) gap++;
  }
  return null;
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// The icon's symbol, not its colors: the middle half of the icon in grey,
// 12 x 12, contrast-normalized. Scrolls of one family share their colors
// and differ only by the symbol (Weapon / Armor / Accessory / Artifact);
// faded (greyed-out) rows keep their shape too. Returns 144 numbers.
const SHAPE_GRID = 12;
async function shapeFingerprint(base, { x0, y0, size }) {
  const W = base.info.width, H = base.info.height;
  const inset = size * 0.25;
  const left = Math.max(0, Math.round(x0 + inset));
  const top = Math.max(0, Math.round(y0 + inset));
  const side = Math.round(size - inset * 2);
  if (side < 8 || left + side > W || top + side > H) return null;
  const px = await sharp(base.data, { raw: base.info })
    .extract({ left, top, width: side, height: side })
    .greyscale()
    .resize(SHAPE_GRID, SHAPE_GRID, { kernel: 'cubic' })
    .raw()
    .toBuffer();
  const v = [...px];
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) || 1;
  return v.map((x) => Math.round(((x - mean) / sd) * 100) / 100);
}
// Average difference of two shape fingerprints (about 0.1-0.3 for the same
// symbol, 0.5+ for a different one).
function shapeDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// How different two icon fingerprints are: average color difference, 0-255.
// Distance over some rows of the icon grid only: a row cut off at the
// list's edge shows just the top (or bottom) half of its icon.
function iconDistancePart(a, b, fromRow, toRow) {
  if (!a || !b || a.length !== b.length) return Infinity;
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  const per = x.length / ICON_GRID;
  let sum = 0, n = 0;
  for (let i = fromRow * per; i < toRow * per; i++, n++) sum += Math.abs(x[i] - y[i]);
  return n ? sum / n : Infinity;
}
function iconDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

// "Monteno Vambrace Damiross-・ILLESTメ" -> item "Monteno Vambrace", source
// "Damiross-・ILLESTメ". The source starts at the boss name right before its
// "-" (cut-off boss names too: "ed Panderre-JuicyFruit").
// `loose`: for a row whose boss is only known from the list's other rows.
// The boss name can be cut down to its last letters with the dash lost too
// ("Piece of the Sky ~ ushXl#\Suszane": "...ush-자본丶" of "Onrush"), so a
// word that starts with the end of a boss word (3+ letters) and runs
// straight into symbols also counts -- never the row's first word, which is
// the item's own ("Midnight ..." would look like "...mid" of Stormid).
function splitAtBoss(seg, boss, { loose = false } = {}) {
  const words = boss.boss.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const isBossWord = (t) => {
    const w = t.toLowerCase();
    return words.some((b) => b === w || (w.length >= 2 && b.endsWith(w)));
  };
  const gluedTail = (t) => {
    const w = t.toLowerCase();
    return words.some((b) => {
      for (let n = 3; n < b.length; n++) if (w.startsWith(b.slice(-n))) return true;
      return false;
    });
  };
  const tokens = [...seg.matchAll(/[A-Za-z]+/g)];
  for (let i = 0; i < tokens.length; i++) {
    const after = seg.slice(tokens[i].index + tokens[i][0].length);
    const dashed = /^\s*[-—–]/.test(after) && isBossWord(tokens[i][0]);
    const glued = loose && i > 0 && /^[^\sA-Za-z]/.test(after) && gluedTail(tokens[i][0]);
    if (!dashed && !glued) continue;
    let start = i;
    while (start > 0 && isBossWord(tokens[start - 1][0]) && /^\s+$/.test(seg.slice(tokens[start - 1].index + tokens[start - 1][0].length, tokens[start].index))) start--;
    const at = tokens[start].index;
    return { item: seg.slice(0, at).trim(), source: seg.slice(at).trim(), found: true };
  }
  // No dash read at all ("r Seal of Advanceme Melville 1 ~ Suszane": the
  // "-자본" came out as "1 ~"): split at the boss's own full name word, as
  // long as it isn't the first word (that's the item's).
  for (let i = 1; i < tokens.length; i++) {
    const w = tokens[i][0].toLowerCase();
    if (w.length < 4 || !words.includes(w)) continue;
    let start = i;
    while (start > 1 && isBossWord(tokens[start - 1][0]) && /^\s+$/.test(seg.slice(tokens[start - 1].index + tokens[start - 1][0].length, tokens[start].index))) start--;
    const at = tokens[start].index;
    return { item: seg.slice(0, at).trim(), source: seg.slice(at).trim(), found: true };
  }
  return { item: '', source: seg, found: false };
}

// The item cell of one row, read on its own: everything left of the
// "Boss-" word, contrast stretched (greyed-out rows are faint) and read as a
// single line. Returns the last column of what it read (icon noise first).
async function rereadItemCell(page, line, scale) {
  const bossWord = line.words.find((w) => /[A-Za-z]{3,}\s*[-—–]/.test(w.text));
  if (!bossWord) return '';
  const meta = await sharp(page).metadata();
  const x1 = bossWord.bbox.x0 - 2;
  const left = Math.max(0, Math.round(x1 - (line.bbox.y1 - line.bbox.y0) * 16));
  const top = Math.max(0, line.bbox.y0 - 4), bottom = Math.min(meta.height, line.bbox.y1 + 4);
  if (x1 - left < 20) return '';
  // Faded text is light grey on lighter grey: try several cut-offs and keep
  // the most confident read that has a real word in its last column.
  let best = { text: '', confidence: -1 };
  for (const cut of [150, 190, 215, 230]) {
    const cell = await sharp(page).extract({ left, top, width: x1 - left, height: bottom - top }).normalise().threshold(cut).extend({ top: 10, bottom: 10, left: 10, right: 10, background: '#ffffff' }).png().toBuffer();
    const res = await recognize(cell, { tessedit_pageseg_mode: '7' });
    const cols = res.text.trim().split(/\s{2,}/).filter(Boolean);
    const text = (cols[cols.length - 1] || '').replace(/^[^A-Za-z]+/, '').trim();
    if ((text.match(/[A-Za-z]/g) || []).length >= 4 && res.confidence > best.confidence) best = { text, confidence: res.confidence };
  }
  return best.text;
}

/**
 * @param {Buffer} buffer  screenshot bytes
 * @returns {Promise<null | Array<{ fragment: string, boss: {schedule, label, boss}, guild: string, wall: string, quantity: number, signature: string }>>}
 *   null when the screenshot isn't a loot list. `fragment` is the item name
 *   as visible (often cut off at the edges); `wall` the kill time as
 *   "YYYY-MM-DDTHH:MM" on the guild's clock.
 */
async function readLootList(buffer) {
  const base = await sharp(buffer).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = base.info.width, H = base.info.height;
  // Light text on dark: grey, inverted (dark on light), enlarged for small UI text.
  const scale = W < 1500 ? 2 : 1;
  const page = await sharp(base.data, { raw: base.info })
    .greyscale()
    .negate()
    .resize({ width: W * scale, kernel: 'lanczos3' })
    .normalise()
    .png()
    .toBuffer();
  const data = await recognize(page, { tessedit_pageseg_mode: '6' });
  if (process.env.LOOT_DEBUG) for (const l of (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines))) console.log('LINE', JSON.stringify(l.text));
  const lines = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines)).filter((l) => KILL_TIME.test(l.text));
  if (lines.length < 1) return null;
  // The list's own row count, at the bottom: 'Stored Quantity 10/100' -- the
  // check that every row was read (see lootRowCheck).
  const storedMatch = String(data.text || '').match(/Stored\s*Quantity\D{0,12}?(\d{1,3})\s*[/|lI]\s*\d{2,3}/i);
  const stored = storedMatch ? Number(storedMatch[1]) : null;

  // The boss this list is about, from the rows that name it clearly. A row
  // whose boss name is cut to a few letters ("ush-자본丶Suszane" of "Stormid
  // of Onrush") was dropped before -- three of six rows on a scrolled list.
  // Only used when every clear row agrees on one boss.
  const clearBosses = lines.map((l) => {
    const before = l.text.replace(/\n/g, ' ').slice(0, l.text.replace(/\n/g, ' ').match(KILL_TIME).index);
    return before.split(/\s{2,}/).map((s) => bossInRow(s)).find(Boolean);
  }).filter(Boolean);
  const listBoss = clearBosses.length && clearBosses.every((b) => b.boss === clearBosses[0].boss) ? clearBosses[0] : null;
  // The kill times (in minutes) of the rows that name their boss clearly.
  const minutesOf = (t) => {
    const m = String(t).replace(/\n/g, ' ').match(KILL_TIME);
    return m ? Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5]) / 60000 : null;
  };
  const clearMinutes = lines.filter((l) => {
    const t = l.text.replace(/\n/g, ' ');
    return t.slice(0, t.match(KILL_TIME).index).split(/\s{2,}/).some((s) => bossInRow(s));
  }).map((l) => minutesOf(l.text)).filter((m) => m != null);

  const rows = [];
  for (const line of lines) {
    const text = line.text.replace(/\n/g, ' ');
    const timeMatch = text.match(KILL_TIME);
    const before = text.slice(0, timeMatch.index);
    const segs = before.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    // A segment with a boss right before a dash wins over one that only has
    // a boss-like word (an item's own name).
    let sourceIdx = segs.findIndex((s) => bossBeforeDash(s));
    if (sourceIdx < 0) sourceIdx = segs.findIndex((s) => findBossInText(s));
    let boss = sourceIdx >= 0 ? bossInRow(segs[sourceIdx]) : null;
    let loose = false;
    if (!boss && listBoss) {
      sourceIdx = segs.findIndex((s) => splitAtBoss(s, listBoss).found);
      if (sourceIdx < 0) [sourceIdx, loose] = [segs.findIndex((s) => splitAtBoss(s, listBoss, { loose: true }).found), true];
      if (sourceIdx >= 0) boss = listBoss;
    }
    // Still no boss: the whole "Boss-Player" cell came out garbled ("paces
    // San" for "Ducas-박민주minju"). If every clear row names one boss and
    // this row's kill time is theirs (within 2 minutes), it's that boss's
    // too -- with the item text unreadable as well, its icon names it.
    let garbled = false;
    if (!boss && listBoss) {
      const at = minutesOf(text);
      if (at != null && clearMinutes.some((m) => Math.abs(m - at) <= 2)) [boss, garbled] = [listBoss, true];
    }
    if (!boss) continue; // no recognizable boss
    // The item is the text just before "Boss-Player". OCR doesn't always
    // leave a wide gap there ("Monteno Vambrace Damiross-・ILLESTメ"), so the
    // source segment is cut at its "Boss-" word first; what comes before it
    // in the same segment is the item. Otherwise it's the segment before;
    // anything before that is OCR noise from the icon. Leftover symbols at
    // the start go, letters stay: a cut-off "k Insignia Fragment" needs its "k".
    let fragment = '';
    if (!garbled) {
      const { item: inSeg, source } = splitAtBoss(segs[sourceIdx], boss, { loose });
      segs[sourceIdx] = source;
      fragment = (/[A-Za-z]{2,}/.test(inSeg) ? inSeg : segs[sourceIdx - 1] || '').replace(/^[^A-Za-z]+/, '').trim();
    }
    // A greyed-out row (an item already handled in game) can come back empty
    // from the whole-page read: read just its item cell again, contrast
    // stretched.
    if (!garbled && (fragment.match(/[A-Za-z]/g) || []).length < 4) {
      const again = await rereadItemCell(page, line, scale).catch((err) => (process.env.LOOT_DEBUG && console.log('reread failed', err.message), ''));
      if (process.env.LOOT_DEBUG) console.log('reread', JSON.stringify(fragment), '->', JSON.stringify(again));
      if ((again.match(/[A-Za-z]/g) || []).length >= 4) fragment = again;
    }
    // No readable name (greyed out to almost nothing, or blurred): the row is
    // kept, nameless -- its icon names it later (buildLootGroups).
    // Under 4 letters is OCR junk off faded text ("Ed", "Hy |"), not a name.
    if ((fragment.match(/[A-Za-z]/g) || []).length < 4) fragment = '';
    // The guild is the last word before the kill time. OCR often leaves no
    // wide gap before it ("Onrush-X[¥~Susza CAPITAL"), so it isn't reliably
    // a segment of its own -- and it must read the same on every screenshot,
    // since overlapping screenshots are lined up by it.
    // (Stray brackets before the time -- "BUBBLEGANG [11.19..." -- are skipped.)
    const guild = before.trim().split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).pop() || '';
    const [, mo, d, y, hh, mi] = timeMatch.map(Number);
    const wall = `${y}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mi)}`;

    // Quantity badge: bottom-right corner of the icon, which sits just left
    // of the item text. Sizes scale with the row's text height.
    // Measured in letter heights, so it works at any screenshot size: the
    // icon is about 3.8 letters tall and ends ~0.8 letters left of the text.
    const firstToken = fragment.split(/\s+/)[0].toLowerCase();
    const itemWord = line.words.find((w) => w.text.replace(/^[^A-Za-z]+/, '').toLowerCase() === firstToken);
    const letterHeights = line.words.filter((w) => /[A-Za-z]{2,}/.test(w.text)).map((w) => (w.bbox.y1 - w.bbox.y0) / scale).sort((a, b) => a - b);
    const textH = letterHeights[Math.floor(letterHeights.length / 2)] || 13;
    let at = null;
    if (itemWord) {
      const textX = itemWord.bbox.x0 / scale;
      const rowMid = (itemWord.bbox.y0 + itemWord.bbox.y1) / 2 / scale;
      const iconSize = textH * 3.8;
      const iconRight = textX - textH * 0.8;
      // The icon itself: cut-off names start at different places, so its
      // right edge is found from the pixels -- the first non-background
      // column left of the text.
      const edge = findIconRight(base, { fromX: textX - textH * 0.2, rowMid, iconSize });
      at = { edge, rowMid, textH, iconRight };
    } else {
      // The item text wasn't among the page's words (a faded row re-read on
      // its own): the row's own height still places its icon, in the icon
      // column the other rows found.
      at = { edge: null, rowMid: (line.bbox.y0 + line.bbox.y1) / 2 / scale, textH, iconRight: null };
    }
    rows.push({ fragment, boss, guild, wall, at, source: garbled ? '' : segs[sourceIdx] });
  }
  if (!rows.length) return null;

  // Icons are one size on a screenshot. A single row's letter height is
  // too noisy to size them from, so use the row spacing (an icon fills
  // ~84% of a row), or with one row, the typical letter height.
  const located = rows.filter((r) => r.at);
  const placed = located.filter((r) => r.at.edge != null);
  const mids = located.map((r) => r.at.rowMid).sort((a, b) => a - b);
  const pitches = mids.slice(1).map((m, i) => m - mids[i]).filter((p) => p > 10);
  const iconSize = pitches.length ? median(pitches) * 0.84 : median(located.map((r) => r.at.textH).concat(12)) * 4;
  // Text is one size on a screenshot too. One row's own letter height can be
  // way off (Tandallon: 17.5 instead of 11.5 on one Frozen Tear row), which
  // made its "2" badge look too small to be a digit -- so badges are sized
  // from the typical row.
  const textH = median(located.map((r) => r.at.textH));
  const edge = placed.length ? median(placed.map((r) => r.at.edge)) : null;
  // Rows are evenly spaced. A row cut off at the list's edge reads its text
  // off-center (Damiross: 943 where the spacing says 932), which put its
  // icon box on the black below the list. Each row is checked against a
  // straight grid fitted through the OTHER rows (so it can't pull the grid
  // toward itself), and moved onto it only when clearly off: 7%+ of a row
  // (that cut-off row: 9.6%; normal rows: 0-5%). The others stay exactly
  // where their text put them.
  if (located.length >= 4) {
    const rough = median(pitches);
    const base = mids[0];
    const pts = located.map((r) => ({ r, k: Math.round((r.at.rowMid - base) / rough), y: r.at.rowMid }));
    const fixes = [];
    for (const p of pts) {
      const others = pts.filter((q) => q !== p);
      const mk = others.reduce((s, q) => s + q.k, 0) / others.length, my = others.reduce((s, q) => s + q.y, 0) / others.length;
      const vk = others.reduce((s, q) => s + (q.k - mk) ** 2, 0);
      if (!vk) continue;
      const pitch = others.reduce((s, q) => s + (q.k - mk) * (q.y - my), 0) / vk;
      const fitted = my + (p.k - mk) * pitch;
      const off = Math.abs(p.y - fitted);
      if (off > pitch * 0.07 && off <= pitch * 0.3) fixes.push([p.r, fitted]);
    }
    for (const [r, fitted] of fixes) r.at.rowMid = fitted;
  }
  for (const r of rows) {
    r.icon = null;
    r.quantity = 1;
    if (r.at) {
      // The icon's right edge is the same column on every row: OCR noise
      // read off the icon art ("Fel Frozen Tear") would otherwise put this
      // row's icon -- and its quantity badge -- in the wrong place.
      if (edge != null) {
        const box = { x0: edge - iconSize, y0: r.at.rowMid - iconSize / 2, size: iconSize };
        r.icon = await iconFingerprint(base, box).catch(() => null);
        r.iconShape = await shapeFingerprint(base, box).catch(() => null);
      }
      // Quantity badge: the bottom-right corner of the icon. Looked for both
      // at the shared icon column and where this row's own text puts it --
      // each finds badges the other misses -- and the badge found wins.
      const badgeAt = (right, size) => readQuantityBadge(base.data, W, H, {
        x0: right - size * 0.55,
        x1: right + 2,
        y0: r.at.rowMid,
        y1: r.at.rowMid + size * 0.6,
        digitHeight: textH * 0.9,
      });
      const own = r.at.iconRight != null ? await badgeAt(r.at.iconRight, textH * 3.8) : 1;
      const shared = edge != null ? await badgeAt(edge, iconSize) : 1;
      r.quantity = Math.max(own, shared);
    }
    r.signature = [r.fragment.toLowerCase(), r.source.toLowerCase().replace(/[^a-z0-9]/g, ''), r.guild.toLowerCase(), r.wall, r.quantity].join('|');
    delete r.at;
    delete r.source;
  }
  rows.stored = stored;
  return rows;
}

// Several screenshots of one scrolling list usually overlap: the rows at
// the bottom of one are the rows at the top of the next. Drops that overlap
// so it isn't counted twice (identical rows are common -- two "Piece of the
// Sky" for the same player -- so this matches whole runs of rows, not single ones).
// Rows are compared by what reads the same on every screenshot -- item,
// guild, kill time, quantity -- not the "Boss-Player" text, which OCR
// varies ("2dPanderre-JuicyFruit" / "dPanderre-JuicyFruit"). The list may
// have been scrolled either way, so the overlap is looked for at both ends.
// The quantity isn't compared: a row cut by the screenshot's edge loses its
// badge ("Frozen Tear" at the bottom of one, "Frozen Tear 2" at the top of
// the next). The shared row keeps the higher count.
// The item is compared by its end: OCR noise from the icon art lands at the
// start of a name ("ONY _'| Alioth's Endurance" on one screenshot,
// "Alioth's Endurance" on the next), and a cut-off name loses its start.
const overlapKey = (r) => [r.boss?.boss, r.guild.toLowerCase().replace(/[^a-z0-9]/g, ''), r.wall].join('|');
// Letters only, with the letters OCR swaps on this font made one (I/l/1,
// O/0): "Blade Surge Il" on one screenshot is "Blade Surge II" on the next.
const itemLetters = (r) => r.fragment.toLowerCase().replace(/[l1|!]/g, 'i').replace(/0/g, 'o').replace(/[^a-z]/g, '');
// Longest run of letters two names share.
function sharedRun(x, y) {
  let best = 0;
  const prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let diag = 0;
    for (let j = 1; j <= y.length; j++) {
      const up = prev[j];
      prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = up;
    }
  }
  return best;
}
const SAME_ROW_ICON = 14; // same item on two screenshots: ~0-9 apart; other items 12+
function sameRow(a, b) {
  if (overlapKey(a) !== overlapKey(b)) return false;
  // Each screenshot cuts the name off at its own place ("Armor Insignia
  // Fragme" / "mor Insignia Fragment"), so the text only has to share most
  // of the shorter one...
  const [x, y] = [itemLetters(a), itemLetters(b)].sort((p, q) => p.length - q.length);
  const textSame = x === y || (x.length >= 6 && sharedRun(x, y) >= x.length * 0.8);
  if (!textSame) return false;
  // ...and the icon decides between items whose names contain each other
  // (Blessing Stone / Brilliant Blessing Stone: same text run, other icon).
  if (a.icon && b.icon && iconDistance(a.icon, b.icon) > SAME_ROW_ICON) return false;
  return true;
}
function mergeLootScreenshots(lists) {
  let merged = [];
  const same = (a, b) => {
    if (a.length !== b.length || !a.every((r, i) => sameRow(r, b[i]))) return false;
    a.forEach((r, i) => { r.quantity = b[i].quantity = Math.max(r.quantity, b[i].quantity); });
    return true;
  };
  for (const rows of lists) {
    let after = 0, before = 0;
    for (let k = Math.min(merged.length, rows.length); k > 0 && !after; k--) {
      if (same(merged.slice(merged.length - k), rows.slice(0, k))) after = k; // scrolled down
    }
    for (let k = Math.min(merged.length, rows.length); k > 0 && !before; k--) {
      if (same(rows.slice(rows.length - k), merged.slice(0, k))) before = k; // scrolled up
    }
    if (after >= before) merged.push(...rows.slice(after));
    else merged = [...rows.slice(0, rows.length - before), ...merged];
  }
  return merged;
}

module.exports = { readLootList, mergeLootScreenshots, iconDistance, iconDistancePart, iconFingerprint, shapeFingerprint, shapeDistance };
