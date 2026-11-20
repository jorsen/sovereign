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

const OCR_DATA_DIR = path.join(__dirname, '..', 'ocr-data');

// "11.20.2026 00:55" -- month.day.year, as the game shows it. The time is
// already the guild's own clock (the list itself says UTC+8).
const KILL_TIME = /(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/;

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
    if (bh >= expected * 0.6 && bh <= expected * 1.5 && bw >= 2 && bw <= expected) digits.push(blob);
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

// How different two icon fingerprints are: average color difference, 0-255.
function iconDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
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
  const lines = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines)).filter((l) => KILL_TIME.test(l.text));
  if (lines.length < 1) return null;

  const rows = [];
  for (const line of lines) {
    const text = line.text.replace(/\n/g, ' ');
    const timeMatch = text.match(KILL_TIME);
    const before = text.slice(0, timeMatch.index);
    const segs = before.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    const sourceIdx = segs.findIndex((s) => findBossInText(s));
    if (sourceIdx < 1) continue; // no recognizable boss, or nothing before it
    const boss = findBossInText(segs[sourceIdx]);
    // The item is the segment just before "Boss-Player"; anything before it
    // is OCR noise from the icon. Strip leftover symbols at its start, but
    // keep letters: a cut-off "k Insignia Fragment" needs its "k".
    const fragment = segs[sourceIdx - 1].replace(/^[^A-Za-z]+/, '').trim();
    if (!/[A-Za-z]{2,}/.test(fragment)) continue;
    const guild = (segs[sourceIdx + 1] || '').replace(/[^\p{L}\p{N} ]/gu, '').trim();
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
    }
    rows.push({ fragment, boss, guild, wall, at, source: segs[sourceIdx] });
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
  const edge = placed.length ? median(placed.map((r) => r.at.edge)) : null;
  for (const r of rows) {
    r.icon = null;
    r.quantity = 1;
    if (r.at) {
      // The icon's right edge is the same column on every row: OCR noise
      // read off the icon art ("Fel Frozen Tear") would otherwise put this
      // row's icon -- and its quantity badge -- in the wrong place.
      if (edge != null) r.icon = await iconFingerprint(base, { x0: edge - iconSize, y0: r.at.rowMid - iconSize / 2, size: iconSize }).catch(() => null);
      // Quantity badge: the bottom-right corner of the icon. Looked for both
      // at the shared icon column and where this row's own text puts it --
      // each finds badges the other misses -- and the badge found wins.
      const badgeAt = (right, size) => readQuantityBadge(base.data, W, H, {
        x0: right - size * 0.55,
        x1: right + 2,
        y0: r.at.rowMid,
        y1: r.at.rowMid + size * 0.6,
        digitHeight: r.at.textH * 0.9,
      });
      const own = await badgeAt(r.at.iconRight, r.at.textH * 3.8);
      const shared = edge != null ? await badgeAt(edge, iconSize) : 1;
      r.quantity = Math.max(own, shared);
    }
    r.signature = [r.fragment.toLowerCase(), r.source.toLowerCase().replace(/[^a-z0-9]/g, ''), r.guild.toLowerCase(), r.wall, r.quantity].join('|');
    delete r.at;
    delete r.source;
  }
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
const overlapKey = (r) => [r.fragment.toLowerCase().replace(/[^a-z]/g, ''), r.boss?.boss, r.guild.toLowerCase().replace(/[^a-z0-9]/g, ''), r.wall, r.quantity].join('|');
function mergeLootScreenshots(lists) {
  let merged = [];
  const same = (a, b) => a.length === b.length && a.every((r, i) => overlapKey(r) === overlapKey(b[i]));
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

module.exports = { readLootList, mergeLootScreenshots, iconDistance };
