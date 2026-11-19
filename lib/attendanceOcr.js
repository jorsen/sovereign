// Reads player names off a Night Crows screenshot for attendance logging,
// with free, local OCR (Tesseract via tesseract.js) -- no paid API.
//
// Only nameplates in our side's colors count: blue (party), green (guild)
// and light green (alliance). The game draws each of those in one exact
// color, so the pipeline is:
//   1. keep only pixels close to those three colors (everything else --
//      white/orange/red names, boss names, UI, terrain -- drops out)
//   2. group those pixels into glyphs, and glyphs into one-line text runs
//   3. drop runs that aren't nameplates: chat (same green as guild names,
//      but always runs off the left screen edge), timestamps, EXP numbers,
//      HUD icons
//   4. OCR each run on its own, as an enlarged black-on-white single line,
//      which Tesseract reads far better than a whole busy screenshot
//
// Pure function of the image: no Discord, no database. The /attendance
// command uses it today; the website logging can reuse it later.
const path = require('path');
const sharp = require('sharp');

// Measured off real screenshots: name text cores are exactly these RGBs.
// In-game chat uses the same green as guild names (filtered by position).
// `tolerance` is how far (RGB distance) a pixel may be from the name color
// and still count -- covers anti-aliased edges. Light green sits close to
// the cream/white of EXP popups and UI text, so it gets a tighter one.
const NAME_COLORS = [
  { color: 'green', rgb: [29, 193, 110], tolerance: 60 },
  { color: 'blue', rgb: [85, 163, 242], tolerance: 60 },
  { color: 'light_green', rgb: [176, 233, 143], tolerance: 42 },
];
// JPEG/WebP compression smears color at thin text edges, so lossy images
// get wider tolerances. Not used for PNG: there it only lets in more noise.
const LOSSY_TOLERANCE_FACTOR = 1.25;

// Korean is needed for guild prefixes like 자본丶; Traditional Chinese for
// prefixes like 伊達 / 主 / 狂 / 神. Loading both into one Tesseract model
// makes each mangle the other's script (박민주 came out as 出圍全), so each
// gets its own reader and the more confident reading of a line wins.
const OCR_LANG_SETS = [['eng', 'kor'], ['eng', 'chi_tra']];

// Screen bands that only ever hold HUD (boss HP bar, menus at the top;
// party frames and skill bar at the bottom), as a fraction of height.
const TOP_HUD = 0.08;
const BOTTOM_HUD = 0.88;
// Chat lines run off the left edge of the screen.
const LEFT_EDGE = 0.012;

// The glyph/nameplate size limits below are tuned for name text about this
// tall (px), which is what a ~1600px-wide game window gives. Screenshots
// whose text comes out clearly smaller or bigger (phone, 4K) are rescaled to
// it first. Measured from the text itself, not the image width, since
// people often post a cropped screenshot whose text is full size.
const TARGET_TEXT_HEIGHT = 15;
const REFERENCE_WIDTH = 1600; // fallback when no text could be measured

const OCR_DATA_DIR = path.join(__dirname, '..', 'ocr-data');

let workersPromise;
function getWorkers() {
  if (!workersPromise) {
    const { createWorker, PSM } = require('tesseract.js');
    // Language data (~9.5MB, tessdata best_int) ships in the repo under
    // ocr-data/ instead of being downloaded from a CDN: serverless cold
    // starts would otherwise re-download it on most calls, and one CDN
    // download took 87s in testing. vercel.json's includeFiles bundles it.
    const options = { langPath: OCR_DATA_DIR, gzip: false, cacheMethod: 'none' };
    workersPromise = Promise.all(
      OCR_LANG_SETS.map(async (langs) => {
        const worker = await createWorker(langs, 1, options);
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, user_defined_dpi: '300' });
        return worker;
      })
    ).catch((err) => {
      workersPromise = null; // let the next call retry instead of caching the failure
      throw err;
    });
  }
  return workersPromise;
}

// Per-pixel: index into NAME_COLORS, or -1.
// Hue / saturation / brightness windows for the same three colors. The
// exact RGB values above only hold at the game's default brightness; a
// darker or washed-out capture (seen: green 75,163,115 instead of
// 29,193,110) keeps the hue but not the RGB. calibrateColors uses these to
// find where a capture's name colors really are.
const NAME_HUES = [
  { hue: 150, hueTol: 14, minSat: 0.4, maxSat: 1, minVal: 0.5 }, // green
  { hue: 211, hueTol: 14, minSat: 0.27, maxSat: 1, minVal: 0.5 }, // blue
  { hue: 96, hueTol: 12, minSat: 0.22, maxSat: 0.65, minVal: 0.55 }, // light green
];

function hueMatch(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d || !mx) return -1;
  const s = d / mx, v = mx / 255;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  for (let t = 0; t < NAME_HUES.length; t++) {
    const c = NAME_HUES[t];
    if (Math.abs(h - c.hue) <= c.hueTol && s >= c.minSat && s <= c.maxSat && v >= c.minVal) return t;
  }
  return -1;
}

// Per-screenshot color calibration. Name text is drawn in one flat color,
// so in any screenshot it forms a tight, dense cluster of identical
// pixels. Near each expected name color (within CALIBRATE_RANGE), this
// finds where that densest cluster actually is -- on a normal capture,
// right on the expected color; on a darker or washed-out one (seen:
// green 62,165,112 instead of 29,193,110) shifted with it -- and returns
// those colors to match against instead.
const CALIBRATE_RANGE = 80;
const CALIBRATE_HUE_TOL = 8; // degrees from the name color's own hue

function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (!d) return -999;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
const CALIBRATE_MIN_PIXELS = 120; // fewer than this: no names of that color, keep the default
function calibrateColors(data, pixelCount) {
  const BIN = 6; // color quantization step
  const key = (r, g, b) => ((r / BIN) | 0) * 4096 + ((g / BIN) | 0) * 64 + ((b / BIN) | 0);
  return NAME_COLORS.map((c, t) => {
    const [tr, tg, tb] = c.rgb;
    const hist = new Map();
    for (let i = 0; i < pixelCount * 3; i += 3) {
      const dr = data[i] - tr, dg = data[i + 1] - tg, db = data[i + 2] - tb;
      if (dr * dr + dg * dg + db * db > CALIBRATE_RANGE * CALIBRATE_RANGE) continue;
      // Must still be that color: right hue, and clearly colored (white and
      // grey UI text is close to light green in RGB, but has no hue). The
      // hue has to be close, not just roughly right: big floating combat
      // text ("Immune", hue ~199) is a dense cluster of nearly the same blue
      // as party names (~210) and would otherwise win.
      if (hueMatch(data[i], data[i + 1], data[i + 2]) !== t) continue;
      if (Math.abs(hueOf(data[i], data[i + 1], data[i + 2]) - NAME_HUES[t].hue) > CALIBRATE_HUE_TOL) continue;
      const k = key(data[i], data[i + 1], data[i + 2]);
      const e = hist.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += data[i]; e.g += data[i + 1]; e.b += data[i + 2];
      hist.set(k, e);
    }
    // Densest spot: bin plus its 26 neighbors.
    let best = null, bestN = 0;
    for (const k of hist.keys()) {
      const br = Math.floor(k / 4096), bg = Math.floor(k / 64) % 64, bb = k % 64;
      let n = 0, r = 0, g = 0, b = 0;
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        const e = hist.get((br + x) * 4096 + (bg + y) * 64 + (bb + z));
        if (e) { n += e.n; r += e.r; g += e.g; b += e.b; }
      }
      if (n > bestN) [bestN, best] = [n, [r / n, g / n, b / n]];
    }
    return bestN >= CALIBRATE_MIN_PIXELS ? best.map(Math.round) : c.rgb;
  });
}

// For a calibrated color: same hue (±10°) and saturation (±0.18) as the
// calibrated center, brightness from 62% to 115% of it.
function shiftedMatch(r, g, b, c) {
  const mx = Math.max(r, g, b);
  if (!mx) return false;
  const v = mx / 255;
  if (v < c.v * 0.62 || v > c.v * 1.15) return false;
  const s = (mx - Math.min(r, g, b)) / mx;
  if (Math.abs(s - c.s) > 0.18) return false;
  return Math.abs(hueOf(r, g, b) - c.h) <= 10;
}

// Per pixel: index into NAME_COLORS, or -1. `centers` are this screenshot's
// name colors (calibrateColors). A color that sits on its default is matched
// by RGB distance, as always; a calibrated (shifted) one comes from a
// blurrier, duller capture where each letter stroke fades from that color
// down to darker shades, so it's matched by hue and saturation at any
// brightness from somewhat darker up to it -- the hue check also keeps out
// nearby effects like the "Immune" combat text (hue ~199 vs ~211).
function classifyPixels(data, pixelCount, toleranceFactor, centers) {
  const cls = new Int8Array(pixelCount).fill(-1);
  const isShifted = NAME_COLORS.map((c, t) => Math.hypot(...centers[t].map((v, k) => v - c.rgb[k])) > 15);
  const centerHsv = centers.map(([r, g, b]) => {
    const mx = Math.max(r, g, b);
    return { h: hueOf(r, g, b), s: mx ? (mx - Math.min(r, g, b)) / mx : 0, v: mx / 255 };
  });
  const tol2 = NAME_COLORS.map((c) => (c.tolerance * toleranceFactor) ** 2);
  if (process.env.ATTENDANCE_OCR_DEBUG) console.log('[ocr] name colors used:', centers.map((c) => c.join(',')).join(' | '));
  for (let p = 0, i = 0; p < pixelCount; p++, i += 3) {
    for (let t = 0; t < NAME_COLORS.length; t++) {
      const [r, g, b] = centers[t];
      const dr = data[i] - r, dg = data[i + 1] - g, db = data[i + 2] - b;
      const hit = isShifted[t] ? shiftedMatch(data[i], data[i + 1], data[i + 2], centerHsv[t]) : dr * dr + dg * dg + db * db < tol2[t];
      if (hit) {
        cls[p] = t;
        break;
      }
    }
  }
  return cls;
}

// 8-connected components of name-colored pixels, with bounding boxes and
// per-color pixel votes.
function findComponents(cls, W, H) {
  const label = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = [];
  for (let p = 0; p < W * H; p++) {
    if (cls[p] < 0 || label[p] >= 0) continue;
    const c = { x0: W, y0: H, x1: 0, y1: 0, n: 0, votes: new Array(NAME_COLORS.length).fill(0) };
    label[p] = comps.length;
    stack.push(p);
    while (stack.length) {
      const q = stack.pop();
      const x = q % W, y = (q / W) | 0;
      c.n++;
      c.votes[cls[q]]++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const r = ny * W + nx;
          if (cls[r] >= 0 && label[r] < 0) {
            label[r] = comps.length;
            stack.push(r);
          }
        }
      }
    }
    c.id = comps.length;
    c.color = c.votes.indexOf(Math.max(...c.votes));
    comps.push(c);
  }
  return { comps, label };
}

const height = (b) => b.y1 - b.y0 + 1;
const width = (b) => b.x1 - b.x0 + 1;
function verticalOverlap(a, b) {
  return Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
}

// Glyphs -> single-line text runs. A glyph joins a run when it sits just to
// the right of it (small gap) and overlaps it vertically -- overlap rather
// than equal centers, so stacked Korean jamo, dots and short CJK strokes
// join the same run as the taller letters next to them. Glyphs only join a
// run of their own color, so a blue nameplate drawn over a green one (common
// in a crowded boss fight) doesn't get its letters mixed in.
function groupIntoRuns(comps, maxSize = 1) {
  // Flat-but-wide pieces count too: dashes in names like ─41─.
  const glyphs = comps.filter((c) => (height(c) >= 3 || width(c) >= 6) && height(c) <= 30 * maxSize && width(c) <= 40 * maxSize && c.n >= 4);
  glyphs.sort((a, b) => a.x0 - b.x0);
  const runs = [];
  for (const g of glyphs) {
    const run = runs.find((r) => {
      const gap = g.x0 - r.x1;
      const overlapNeeded = Math.max(1, Math.min(height(r), height(g)) * 0.4);
      // g.x0 >= r.x0 rather than a minimum gap: when two of our nameplates
      // overlap on screen, glyphs drawn on top of each other join the same
      // run instead of producing a second, garbage run.
      return r.color === g.color && gap <= 10 * maxSize && g.x0 >= r.x0 - 2 && verticalOverlap(r, g) >= overlapNeeded && Math.max(r.y1, g.y1) - Math.min(r.y0, g.y0) <= 26 * maxSize;
    });
    if (run) {
      run.x1 = Math.max(run.x1, g.x1);
      run.y0 = Math.min(run.y0, g.y0);
      run.y1 = Math.max(run.y1, g.y1);
      run.parts.push(g);
    } else {
      runs.push({ x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1, color: g.color, parts: [g] });
    }
  }
  return runs;
}

// Chat rows start at the left screen edge; any run on the same row that
// chains on from there (sender name -> colon -> message words) is chat too.
function chatRunSet(runs, W) {
  const chat = new Set();
  const starts = runs.filter((r) => r.x0 <= W * LEFT_EDGE);
  for (const start of starts) {
    chat.add(start);
    let end = start.x1;
    const sameRow = runs.filter((r) => r !== start && verticalOverlap(r, start) >= Math.min(height(r), height(start)) * 0.5).sort((a, b) => a.x0 - b.x0);
    for (const r of sameRow) {
      if (r.x0 < start.x0 || r.x0 - end > 30) continue;
      chat.add(r);
      end = Math.max(end, r.x1);
    }
  }
  return chat;
}

// The guild crest before a name and the shield after it can share the
// name's color (on dull captures especially, blue names and the blue
// crest), leaving small bits stuck to either end that OCR reads as extra
// letters ("07hRADARIP" for BÁDtRiP). Drops end pieces that are clearly
// shorter than the letters and stand alone -- nothing above or below them,
// with a gap to the next piece. Korean syllables, whose stacked pieces
// overlap, are never touched; dots like the ・ in ・ILLESTメ may go, but
// punctuation doesn't count when names are compared anyway.
function trimIconBits(run) {
  const parts = run.parts.slice().sort((a, b) => a.x0 - b.x0);
  if (parts.length < 4) return;
  const heights = parts.map(height).sort((a, b) => a - b);
  const letterH = heights[Math.floor(heights.length * 0.75)];
  // Crest bits are short *and* narrow (3x3, 4x8, 5x5); flat dashes (─41─)
  // and the half-hidden bottoms of covered letters (9x4) are wide, and kept.
  const loneShort = (p, others) => height(p) < letterH * 0.65 && width(p) < height(p) * 1.2 && !others.some((o) => o !== p && o.x0 <= p.x1 && o.x1 >= p.x0);
  while (parts.length > 3 && loneShort(parts[0], parts) && parts[1].x0 - parts[0].x1 >= 3) parts.shift();
  while (parts.length > 3 && loneShort(parts[parts.length - 1], parts) && parts[parts.length - 1].x0 - parts[parts.length - 2].x1 >= 3) parts.pop();
  if (parts.length === run.parts.length) return;
  run.parts = parts;
  run.x0 = Math.min(...parts.map((p) => p.x0));
  run.x1 = Math.max(...parts.map((p) => p.x1));
  run.y0 = Math.min(...parts.map((p) => p.y0));
  run.y1 = Math.max(...parts.map((p) => p.y1));
}

function looksLikeNameplate(run, W, H, maxSize = 1) {
  const tall = run.parts.filter((p) => height(p) >= 8);
  return (
    tall.length >= 2 &&
    width(run) >= 18 &&
    height(run) >= 9 &&
    height(run) <= 26 * maxSize &&
    run.y0 >= H * TOP_HUD &&
    run.y1 <= H * BOTTOM_HUD
  );
}

// Tesseract misreads that only ever show up as noise around a name.
const STRIP_EDGES = /^[\s'"‘’“”`´^~,.:;|_!¡()[\]{}<>«»*]+|[\s'"‘’“”`´^~,.:;|_!¡()[\]{}<>«»*]+$/gu;

// NFKC folds full-width letters (Ｊｅｎｎ) into normal ones, so the same
// player read slightly differently across two screenshots still dedupes.
// Guild-tag names are written like 자본丶Suszane. Tesseract reads that small
// 丶 stroke as ~ > * ` ' ^ and so on, differently every time, so a single
// symbol between a Korean/Chinese/Japanese prefix and a Latin name is put
// back as 丶.
const TAG_SEPARATOR = /^([\p{Script=Hangul}\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}]+)[~>*`'^·.,、ヽ\\/\-_丶]([A-Za-z0-9].*)$/u;

function normalizeName(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/\s+/g, '') // in-game names can't contain spaces; OCR adds them
    .replace(STRIP_EDGES, '')
    .replace(TAG_SEPARATOR, '$1丶$2')
    .trim();
}

// Dedupe key: letters and digits only, so one player read with slightly
// different symbols in two screenshots still counts once.
function nameKey(name) {
  return normalizeName(name).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Timestamps (23:01), EXP/gold numbers (721,386), stray digits and lone
// symbols are not names. Names with no letters do exist, but the ones seen
// so far are dash-framed numbers (─41─), so letterless text needs a dash.
function isPlausibleName(text) {
  if (text.length < 2) return false;
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters === 0) return /\d/.test(text) && /[-─—–=~]/.test(text) && !/[:,.+()%]/.test(text);
  return true;
}

// Black-on-white crop of one run, enlarged, with a white margin. Drawn: the
// run's own glyphs, plus loose same-color fragments too small to be glyphs
// (thin anti-aliased strokes, like the diagonal of a 4, break off into
// those). Left out: anything of another color and any glyph belonging to a
// different run, so an overlapping nameplate doesn't bleed in.
async function renderRun(cls, label, runOf, W, H, run, scale) {
  const pad = 4;
  const left = Math.max(0, run.x0 - pad), top = Math.max(0, run.y0 - pad);
  const w = Math.min(W, run.x1 + pad + 1) - left, h = Math.min(H, run.y1 + pad + 1) - top;
  const crop = Buffer.alloc(w * h, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (top + y) * W + left + x;
      if (cls[p] !== run.color) continue;
      const owner = runOf.get(label[p]);
      if (owner === undefined || owner === run) crop[y * w + x] = 0;
    }
  }
  return sharp(crop, { raw: { width: w, height: h, channels: 1 } })
    .resize({ width: w * scale, kernel: 'lanczos3' })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#ffffff' })
    .png()
    .toBuffer();
}

/**
 * @param {Buffer} buffer  raw image bytes (png/jpeg/webp)
 * @returns {Promise<Array<{name: string, color: 'blue'|'green'|'light_green', uncertain: boolean}>>}
 */
// Finds the nameplate runs in an RGB image at one particular scale.
async function segment(base, scale, toleranceFactor, centers, maxSize = 1) {
  let data = base.data, W = base.info.width, H = base.info.height;
  if (scale !== 1) {
    const out = await sharp(base.data, { raw: base.info })
      .resize({ width: Math.round(W * scale), kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    [data, W, H] = [out.data, out.info.width, out.info.height];
  }
  const cls = classifyPixels(data, W * H, toleranceFactor, centers);
  const { comps, label } = findComponents(cls, W, H);
  const runs = groupIntoRuns(comps, maxSize);
  const chat = chatRunSet(runs, W);
  const candidates = runs.filter((r) => !chat.has(r) && looksLikeNameplate(r, W, H, maxSize));
  const heights = candidates.map(height).sort((a, b) => a - b);
  const textHeight = heights.length >= 2 ? heights[Math.floor(heights.length / 2)] : null;
  return { W, H, cls, label, candidates, textHeight };
}

// Measures the name text height with the upper size limits relaxed (so 4K
// text, up to ~3x normal size, still registers), then segments for real at
// whatever scale brings the text to TARGET_TEXT_HEIGHT. Screenshots already
// within 20% of it are used as-is. If no text could be measured at all,
// falls back to scaling by image width.
// The sizes to read a screenshot at. Shrinking or enlarging blurs thin,
// half-covered or light letters differently, so one size can read a name
// another garbles (STORM and ─41─ were lost on a big capture shrunk to the
// working size, but read fine at its own size). Each screenshot is read at
// the working text size and at its own size, and the readings are pooled;
// the Growth Rate matching then keeps the clearest reading of each person.
async function segmentAtTextSizes(base, toleranceFactor, centers) {
  const probe = await segment(base, 1, toleranceFactor, centers, 3);
  const target = probe.textHeight
    ? TARGET_TEXT_HEIGHT / probe.textHeight
    : REFERENCE_WIDTH / base.info.width;
  const wanted = (process.env.OCR_SCALES || 'target,native').split(',');
  const scales = [];
  for (const w of wanted) {
    const s = w === 'native' ? 1 : w === 'up' ? target * 1.3 : target;
    // Skip sizes within 12% of one already read: same result, double time.
    if (s >= 0.4 && s <= 3 && !scales.some((x) => Math.abs(x / s - 1) < 0.12)) scales.push(s);
  }
  const segs = [];
  for (const s of scales) segs.push(await segment(base, Math.abs(s - 1) < 0.02 ? 1 : s, toleranceFactor, centers));
  return segs;
}

async function readNamesFromScreenshot(buffer) {
  const meta = await sharp(buffer).metadata();
  const base = await sharp(buffer).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lossy = meta.format === 'jpeg' || meta.format === 'webp';
  // Calibrated once on the screenshot as captured, then used at every scale.
  const centers = calibrateColors(base.data, base.info.width * base.info.height);
  const names = [];
  for (const seg of await segmentAtTextSizes(base, lossy ? LOSSY_TOLERANCE_FACTOR : 1, centers)) {
    names.push(...(await readSegment(seg)));
  }
  return names;
}

// OCRs every nameplate found at one size.
async function readSegment({ W, H, cls, label, candidates }) {
  // Which nameplate each glyph belongs to. Only real nameplates count: bits
  // that formed a tiny run of their own (the broken-off stroke of a 4) are
  // still drawn into whichever nameplate they sit in.
  const runOf = new Map();
  for (const run of candidates) for (const part of run.parts) runOf.set(part.id, run);

  const [korWorker, chiWorker] = await getWorkers();
  const seen = new Set();
  const names = [];
  for (const run of candidates) {
    trimIconBits(run);
    const plain = await renderRun(cls, label, runOf, W, H, run, 4);
    // Same crop with strokes thickened a little: rejoins thin strokes the
    // color mask broke apart (JuicyFruit's u, the diagonal of a 4).
    const thick = await sharp(plain).blur(1.6).threshold(200).png().toBuffer();

    // No single setting reads every nameplate right -- in testing, each of
    // these was the only one to get some name correct -- so every reading
    // is kept as an alternative and the Growth Rate matching
    // (rosterMatch.js) picks whichever one fits a known member.
    const [korPlain, chiPlain] = await Promise.all([recognize(korWorker, plain, 'line'), recognize(chiWorker, plain, 'line')]);
    const [korThick, chiThick] = await Promise.all([recognize(korWorker, thick, 'line'), recognize(chiWorker, thick, 'line')]);
    const korPlainWord = await recognize(korWorker, plain, 'word');
    const korThickWord = await recognize(korWorker, thick, 'word');
    const all = [korPlain, chiPlain, korThick, chiThick, korPlainWord, korThickWord];

    // The main reading (shown when nothing on the Growth Rate list fits):
    // plain single-line, Korean reader if it found Hangul -- the Chinese
    // reader turns Hangul into look-alike Han characters with decent
    // confidence -- otherwise whichever reader was more confident.
    const main = /\p{Script=Hangul}/u.test(korPlain.text) ? korPlain : korPlain.confidence >= chiPlain.confidence ? korPlain : chiPlain;
    if (process.env.ATTENDANCE_OCR_DEBUG) {
      console.log(`[ocr] x=${run.x0} y=${run.y0} w=${width(run)} h=${height(run)} parts=${run.parts.length}`, all.map((r) => `${JSON.stringify(r.text.trim())}@${Math.round(r.confidence)}`).join(' | '));
    }
    const alternatives = [...new Set(all.map((r) => normalizeName(r.text)).filter(isPlausibleName))];
    const mainName = normalizeName(main.text);
    const name = isPlausibleName(mainName) ? mainName : alternatives[0];
    if (!name || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    names.push({
      name,
      alternatives: alternatives.filter((a) => a !== name),
      color: NAME_COLORS[run.color].color,
      // Tesseract's own confidence: low usually means an overlapped or
      // effect-covered nameplate -- flagged so someone double-checks it.
      uncertain: main.confidence < 70 || name !== mainName,
    });
  }
  return names;
}

// mode 'line' = one line of text (the default read); 'word' = one word,
// which reads some short or symbol-heavy names that 'line' returns empty.
async function recognize(worker, png, mode) {
  const { PSM } = require('tesseract.js');
  await worker.setParameters({ tessedit_pageseg_mode: mode === 'word' ? PSM.SINGLE_WORD : PSM.SINGLE_LINE });
  return (await worker.recognize(png)).data;
}

// Merges several screenshots' results into one list, first sighting wins.
// A name read confidently in any screenshot is not flagged uncertain.
function mergeNameLists(lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const entry of list) {
      const key = nameKey(entry.name);
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, { ...entry });
      else if (!entry.uncertain) existing.uncertain = false;
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

module.exports = { readNamesFromScreenshot, mergeNameLists, normalizeName };
