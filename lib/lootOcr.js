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
  // Black digits on white, enlarged, for the OCR.
  const crop = Buffer.alloc(w * h, 255);
  for (const d of digits) for (const q of d.px) crop[q] = 0;
  const png = await sharp(crop, { raw: { width: w, height: h, channels: 1 } })
    .resize({ width: w * 6, kernel: 'lanczos3' })
    .extend({ top: 24, bottom: 24, left: 24, right: 24, background: '#ffffff' })
    .png()
    .toBuffer();
  const res = await recognize(png, { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789' });
  const n = Number(res.text.trim());
  return Number.isInteger(n) && n >= 2 && n <= 999 && res.confidence >= 50 ? n : 1;
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
    let quantity = 1;
    if (itemWord) {
      const textX = itemWord.bbox.x0 / scale;
      const rowMid = (itemWord.bbox.y0 + itemWord.bbox.y1) / 2 / scale;
      const iconSize = textH * 3.8;
      const iconRight = textX - textH * 0.8;
      quantity = await readQuantityBadge(base.data, W, H, {
        x0: iconRight - iconSize * 0.55,
        x1: iconRight + 2,
        y0: rowMid,
        y1: rowMid + iconSize * 0.6,
        digitHeight: textH * 0.9,
      });
    }

    const signature = [fragment.toLowerCase(), segs[sourceIdx].toLowerCase().replace(/[^a-z0-9]/g, ''), guild.toLowerCase(), wall, quantity].join('|');
    rows.push({ fragment, boss, guild, wall, quantity, signature });
  }
  return rows.length ? rows : null;
}

// Several screenshots of one scrolling list usually overlap: the rows at
// the bottom of one are the rows at the top of the next. Drops that overlap
// so it isn't counted twice (identical rows are common -- two "Piece of the
// Sky" for the same player -- so this matches whole runs of rows, not single ones).
function mergeLootScreenshots(lists) {
  const merged = [];
  for (const rows of lists) {
    let overlap = 0;
    for (let k = Math.min(merged.length, rows.length); k > 0; k--) {
      const tail = merged.slice(merged.length - k).map((r) => r.signature);
      const head = rows.slice(0, k).map((r) => r.signature);
      if (tail.every((s, i) => s === head[i])) { overlap = k; break; }
    }
    merged.push(...rows.slice(overlap));
  }
  return merged;
}

module.exports = { readLootList, mergeLootScreenshots };
