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
// A third, Chinese-only reader for unclear nameplates: paired with English,
// the Chinese reader "sees" Latin letters in small Han names (殺豬小隊ฅ金元寶ฅ
// came out as "MR aS TE"); alone it reads them ("殺豬小隊@金元容").
// A fourth, Japanese-only reader: hiragana/katakana names (とらふ) aren't in
// any of the others; it reads them best from a small (2x) render.
const OCR_LANG_SETS = [['eng', 'kor'], ['eng', 'chi_tra'], ['chi_tra'], ['jpn']];

// Screen bands that only ever hold HUD (boss HP bar, menus at the top;
// party frames and skill bar at the bottom), as a fraction of height.
// Kept thin: cropped screenshots put nameplates right at the top (STORM).
const TOP_HUD = 0.02;
const BOTTOM_HUD = 0.88;
// Chat lines run off the left edge of the screen.
const LEFT_EDGE = 0.012;
// Chat lines indented by an icon or channel tag: a stack of this many rows
// starting in this left fraction of the screen.
const CHAT_LEFT = 0.12;
const CHAT_MIN_ROWS = 3;

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
// ...measured on a ~1600x900 capture; small screenshots (a 920x595 phone
// shot) have proportionally fewer name pixels, so the bar scales with area.
const CALIBRATE_REF_AREA = 1600 * 900;
const calibrateMinPixels = (pixelCount) => Math.max(30, Math.min(CALIBRATE_MIN_PIXELS, Math.round(CALIBRATE_MIN_PIXELS * pixelCount / CALIBRATE_REF_AREA)));
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
    return bestN >= calibrateMinPixels(pixelCount) ? best.map(Math.round) : c.rgb;
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
  if (centers.soft) return classifySoft(data, pixelCount);
  const cls = new Int8Array(pixelCount).fill(-1);
  // Pixels taken in by the dim-blue fallback: their nameplates are read, but
  // not used to measure the text size (junk dark-blue shapes would skew it).
  const dim = new Uint8Array(pixelCount);
  cls.dim = dim;
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
    // Faded guild green: on a soft capture, a short green name standing in a
    // green skill effect (Jenn) comes out washed-out (~100,184,136) -- too few
    // pixels to calibrate on, too far from the default green to match it.
    // Same hue family, lower saturation, not another name color.
    if (cls[p] < 0 && !isShifted[GREEN] && fadedGreen(data[i], data[i + 1], data[i + 2])) cls[p] = GREEN;
    // Dim party blue: one name drawn darker than the others (자본丶Sammyyy at
    // ~50,100,145 next to bright-blue names), so calibration keeps the bright one.
    else if (cls[p] < 0 && !isShifted[BLUE] && dimBlue(data[i], data[i + 1], data[i + 2])) {
      cls[p] = BLUE;
      dim[p] = 1;
    }
  }
  return cls;
}
// Soft colors, for a blurry capture (a phone photo or a recording of the
// screen): each name's letters smear into a spread of duller shades -- the
// light-green 박민주minju at ~150,192,132 and the blue 자본丶Suszane at
// ~72,108,144 -- with no tight cluster for calibrateColors to find. Matched
// by hue alone, at any reasonably bright, clearly colored shade. Looser than
// the normal pass, so only used as a second pass (readNamesFromScreenshot).
const SOFT_HUES = [
  { hue: 150, hueTol: 15, minSat: 0.35, maxSat: 0.9, minVal: 0.45 }, // green
  { hue: 211, hueTol: 11, minSat: 0.35, maxSat: 0.85, minVal: 0.45 }, // blue
  { hue: 96, hueTol: 16, minSat: 0.2, maxSat: 0.55, minVal: 0.5 }, // light green
];
function classifySoft(data, pixelCount) {
  const cls = new Int8Array(pixelCount).fill(-1);
  cls.dim = new Uint8Array(pixelCount);
  for (let p = 0, i = 0; p < pixelCount; p++, i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b);
    if (!mx) continue;
    const s = (mx - Math.min(r, g, b)) / mx, v = mx / 255, h = hueOf(r, g, b);
    for (let t = 0; t < SOFT_HUES.length; t++) {
      const c = SOFT_HUES[t];
      if (Math.abs(h - c.hue) <= c.hueTol && s >= c.minSat && s <= c.maxSat && v >= c.minVal) {
        cls[p] = t;
        break;
      }
    }
  }
  return cls;
}
const SOFT_CENTERS = Object.assign(NAME_COLORS.map((c) => c.rgb), { soft: true });

const GREEN = NAME_COLORS.findIndex((c) => c.color === 'green');
const BLUE = NAME_COLORS.findIndex((c) => c.color === 'blue');
function dimBlue(r, g, b) {
  const mx = Math.max(r, g, b);
  if (mx < 120 || mx > 215 || b !== mx) return false;
  const s = (mx - Math.min(r, g, b)) / mx;
  if (s < 0.5 || s > 0.8) return false;
  const h = hueOf(r, g, b);
  return h >= 202 && h <= 220;
}
function fadedGreen(r, g, b) {
  const mx = Math.max(r, g, b);
  if (mx < 110) return false;
  const s = (mx - Math.min(r, g, b)) / mx;
  if (s < 0.22 || s > 0.75) return false;
  const h = hueOf(r, g, b);
  return h >= 130 && h <= 165;
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
  const edge = runs.filter((r) => r.x0 <= W * LEFT_EDGE);
  // Chat comes in stacked rows; a lone nameplate cut by the screen edge
  // (BÁDtRiP standing at the left border) has no other edge row near it.
  // Only text-sized rows count (specks of the cut crest beside it don't).
  const rows = edge.filter((r) => height(r) >= 8 && width(r) >= 12);
  const starts = edge.filter((r) => rows.some((o) => o !== r && verticalOverlap(o, r) <= 0 && Math.abs(o.y0 - r.y0) <= height(r) * 4));
  // Chat lines often don't touch the edge: a rank icon ("🏆 STORM: eto?")
  // or channel tag ("[SEA110] Kiiyotakaツ:") comes first. So also: 3+
  // name-colored rows in the left part of the screen, stacked one under
  // the other at chat-line spacing. Fighting nameplates are scattered, not
  // a column like that.
  const left = runs
    .filter((r) => r.x0 <= W * CHAT_LEFT && height(r) >= 8 && width(r) >= 12)
    .sort((a, b) => a.y0 - b.y0);
  // Chat lines start at nearly the same x, so a stack only takes rows lined
  // up with it (within 3 letter heights) -- a nameplate further right at a
  // similar height starts its own stack instead of joining the chat column.
  const stacks = [];
  for (const r of left) {
    const h = height(r);
    const fits = (s) => {
      const last = s[s.length - 1];
      return Math.abs(r.x0 - s[0].x0) <= h * 3 && r.y0 - last.y0 <= Math.max(height(last), h) * 5.5;
    };
    const stack = stacks.find((s) => fits(s) || verticalOverlap(s[s.length - 1], r) > 0);
    if (!stack) {
      stacks.push([r]);
      continue;
    }
    const last = stack[stack.length - 1];
    if (verticalOverlap(last, r) > 0) {
      // Same row: the leftmost run is the line's start (the sender name).
      if (r.x0 < last.x0) stack[stack.length - 1] = r;
      continue;
    }
    // (A wrapped chat line, white text only, can leave a gap of one row.)
    stack.push(r);
  }
  for (const s of stacks) if (s.length >= CHAT_MIN_ROWS) for (const r of s) if (!starts.includes(r)) starts.push(r);
  for (const start of starts) {
    chat.add(start);
    let end = start.x1;
    const sameRow = runs.filter((r) => r !== start && verticalOverlap(r, start) >= Math.min(height(r), height(start)) * 0.5).sort((a, b) => a.x0 - b.x0);
    for (const r of sameRow) {
      if (r.x0 < start.x0 || r.x0 - end > Math.max(30, height(start) * 4)) continue;
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
  // A number name framed by dashes (一41一) whose digits touch: one tall part
  // between two flat dash strokes.
  const tallH = tall.length ? Math.max(...tall.map(height)) : 0;
  const dashes = run.parts.filter((p) => height(p) <= Math.max(3, tallH * 0.3) && width(p) >= tallH * 0.6);
  const framedNumber = tall.length === 1 && dashes.some((d) => d.x1 <= tall[0].x0) && dashes.some((d) => d.x0 >= tall[0].x1);
  return (
    (tall.length >= 2 || framedNumber) &&
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
// Below this Tesseract confidence, a nameplate gets a second look.
const SECOND_LOOK_BELOW = 75;

// The nameplate straight from the screenshot, not the color mask: grey,
// contrast-stretched, inverted (dark letters on light), enlarged 5x.
async function originalCrop(data, W, H, run) {
  const pad = 4;
  const left = Math.max(0, run.x0 - pad), top = Math.max(0, run.y0 - pad);
  const width_ = Math.min(W, run.x1 + pad + 1) - left, height_ = Math.min(H, run.y1 + pad + 1) - top;
  return sharp(data, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left, top, width: width_, height: height_ })
    .greyscale()
    .normalise()
    .negate()
    .resize({ width: width_ * 5, kernel: 'lanczos3' })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#ffffff' })
    .png()
    .toBuffer();
}

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
      if (owner === undefined || owner === run || run.joinOf?.includes(owner)) crop[y * w + x] = 0;
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
// A name the color filter broke in two on a soft capture ("Beer" + "Shadow",
// letters lost in between): two runs of one color on one line, a short gap
// apart, are also read as one nameplate -- each half is still read too.
function joinedRuns(candidates) {
  const joined = [];
  for (const a of candidates) {
    let best = null;
    for (const b of candidates) {
      if (a === b || a.color !== b.color) continue;
      const h = Math.max(height(a), height(b));
      const gap = b.x0 - a.x1;
      if (gap <= 0 || gap > h * JOIN_MAX_GAP) continue;
      if (verticalOverlap(a, b) < Math.min(height(a), height(b)) * 0.5) continue;
      if (b.x1 - a.x0 > h * 14) continue;
      if (!best || b.x0 < best.x0) best = b;
    }
    if (best) {
      joined.push({
        x0: a.x0, x1: best.x1, y0: Math.min(a.y0, best.y0), y1: Math.max(a.y1, best.y1),
        color: a.color, parts: [...a.parts, ...best.parts], joinOf: [a, best], dim: a.dim && best.dim,
      });
    }
  }
  return joined;
}
const JOIN_MAX_GAP = 2; // letter heights

function chainPieces(runs, maxSize) {
  const chains = [];
  const used = new Set();
  const sorted = [...runs].filter((r) => height(r) >= 4).sort((a, b) => a.x0 - b.x0);
  for (const start of sorted) {
    if (used.has(start)) continue;
    const chain = [start];
    let last = start;
    for (const r of sorted) {
      if (r.x0 <= last.x0 || used.has(r) || r.color !== start.color) continue;
      const h = Math.max(height(last), height(r), 8);
      const gap = r.x0 - last.x1;
      if (gap < -2 || gap > Math.max(10 * maxSize, h * CHAIN_MAX_GAP)) continue;
      if (verticalOverlap(last, r) < Math.min(height(last), height(r)) * 0.5) continue;
      chain.push(r);
      last = r;
    }
    if (chain.length < 2) continue;
    chain.forEach((r) => used.add(r));
    chains.push({
      x0: Math.min(...chain.map((r) => r.x0)), x1: Math.max(...chain.map((r) => r.x1)),
      y0: Math.min(...chain.map((r) => r.y0)), y1: Math.max(...chain.map((r) => r.y1)),
      color: start.color, parts: chain.flatMap((r) => r.parts), joinOf: chain,
    });
  }
  return chains;
}
const CHAIN_MAX_GAP = 1.2; // letter heights

// A run made mostly of dim-blue fallback pixels (classifyPixels).
function isDimRun(r, cls, W) {
  let d = 0, n = 0;
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    const p = y * W + x;
    if (cls[p] < 0) continue;
    n++;
    d += cls.dim[p];
  }
  return n > 0 && d / n > 0.5;
}

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
  // A name broken into pieces too small to be nameplates on their own
  // ("・I" + "LLES" + "Tメ" on a soft capture): same-color pieces on one
  // line, close for their size, are chained into one extra nameplate.
  for (const chain of process.env.NO_CHAIN ? [] : chainPieces(runs.filter((r) => !chat.has(r)), maxSize)) {
    // Only for pieces too small to count alone: two full nameplates side by
    // side (a crest and its name) are joinedRuns' job.
    if (chain.joinOf.every((p) => candidates.includes(p))) continue;
    if (looksLikeNameplate(chain, W, H, maxSize) && !candidates.some((c) => c.x0 === chain.x0 && c.x1 === chain.x1)) candidates.push(chain);
  }
  // Text size from the regular nameplates only, not dim-blue ones.
  for (const r of candidates) r.dim = isDimRun(r, cls, W);
  const heights = candidates.filter((r) => !r.dim && !r.joinOf).map(height).sort((a, b) => a - b);
  const textHeight = heights.length >= 2 ? heights[Math.floor(heights.length / 2)] : null;
  return { W, H, cls, label, candidates, textHeight, data, scale };
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

// deep: the Rescan button's "try harder" -- every nameplate gets every
// setting, both sizes and the second look, not just the unclear ones.
async function readNamesFromScreenshot(buffer, { deep = false } = {}) {
  const meta = await sharp(buffer).metadata();
  const base = await sharp(buffer).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lossy = meta.format === 'jpeg' || meta.format === 'webp';
  // Calibrated once on the screenshot as captured, then used at every scale.
  const centers = calibrateColors(base.data, base.info.width * base.info.height);
  const names = [];
  // Nameplates already read clearly at one size aren't read again at the
  // next (same name, double the time) -- only the unclear ones are.
  const clearBoxes = [];
  for (const seg of await segmentAtTextSizes(base, lossy ? LOSSY_TOLERANCE_FACTOR : 1, centers)) {
    const result = await readSegment(seg, deep ? [] : clearBoxes, deep);
    names.push(...result.names);
    clearBoxes.push(...result.clearBoxes);
  }
  // Blurry capture: nothing read clearly with the exact name colors, so read
  // it again with the soft ones. Rescan always does, for whatever was missed.
  // Extra readings are harmless: /attendance keeps only Growth Rate matches.
  if (deep || !names.some((n) => !n.uncertain)) {
    const seen = new Set(names.map((n) => nameKey(n.name)));
    for (const seg of await segmentAtTextSizes(base, 1, SOFT_CENTERS)) {
      const result = await readSegment(seg, deep ? [] : clearBoxes, deep);
      for (const n of result.names) if (!seen.has(nameKey(n.name))) {
        seen.add(nameKey(n.name));
        names.push(n);
      }
      clearBoxes.push(...result.clearBoxes);
    }
  }
  return names;
}

// A nameplate's box in the screenshot's own pixels (segments may be resized).
const baseBox = (run, scale) => ({ x0: run.x0 / scale, y0: run.y0 / scale, x1: run.x1 / scale, y1: run.y1 / scale });
function overlapsMostly(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return false;
  const smaller = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return (w * h) / smaller > 0.5;
}

// A first read at or above this Tesseract confidence is taken as clear: no
// further settings or second look for that nameplate.
const CLEAR_READ = 80;

// OCRs every nameplate found at one size, skipping ones already read
// clearly (skipBoxes). Returns the readings and the boxes read clearly here.
async function readSegment({ W, H, cls, label, candidates, data, scale }, skipBoxes = [], deep = false) {
  const clearBoxes = [];
  // Which nameplate each glyph belongs to. Only real nameplates count: bits
  // that formed a tiny run of their own (the broken-off stroke of a 4) are
  // still drawn into whichever nameplate they sit in.
  const runOf = new Map();
  // (Chained plates borrow their pieces' glyphs; they don't own them.)
  for (const run of candidates) if (!run.joinOf) for (const part of run.parts) runOf.set(part.id, run);

  const [korWorker, chiWorker, hanWorker, jpnWorker] = await getWorkers();
  const seen = new Set();
  const names = [];
  for (const run of [...candidates, ...joinedRuns(candidates)]) {
    if (!run.joinOf) trimIconBits(run);
    const box = baseBox(run, scale || 1);
    if (skipBoxes.some((b) => overlapsMostly(b, box))) continue;
    const plain = await renderRun(cls, label, runOf, W, H, run, 4);

    // First, the two quick reads. The main reading (shown when nothing on
    // the Growth Rate list fits): plain single-line, Korean reader if it
    // found Hangul -- the Chinese reader turns Hangul into look-alike Han
    // characters with decent confidence -- otherwise whichever reader was
    // more confident. A clear one (≥ CLEAR_READ) is enough by itself.
    const [korPlain, chiPlain] = await Promise.all([recognize(korWorker, plain, 'line'), recognize(chiWorker, plain, 'line')]);
    const all = [korPlain, chiPlain];
    const main = /\p{Script=Hangul}/u.test(korPlain.text) ? korPlain : korPlain.confidence >= chiPlain.confidence ? korPlain : chiPlain;
    if (main.confidence >= CLEAR_READ && !run.joinOf) clearBoxes.push(box);

    // Not clear: more settings. No single one reads every nameplate right
    // -- in testing, each was the only one to get some name correct -- so
    // every reading is kept as an alternative and the Growth Rate matching
    // (rosterMatch.js) picks whichever one fits a known member. The thick
    // crop rejoins thin strokes the color mask broke apart (JuicyFruit's u,
    // the diagonal of a 4); word mode reads short, symbol-heavy names.
    if (deep || main.confidence < CLEAR_READ) {
      const thick = await sharp(plain).blur(1.6).threshold(200).png().toBuffer();
      const [korThick, chiThick] = await Promise.all([recognize(korWorker, thick, 'line'), recognize(chiWorker, thick, 'line')]);
      all.push(korThick, chiThick, await recognize(korWorker, plain, 'word'), await recognize(korWorker, thick, 'word'));
      const small = await renderRun(cls, label, runOf, W, H, run, 2);
      all.push(...(await Promise.all([recognize(hanWorker, plain, 'line'), recognize(hanWorker, thick, 'line'), recognize(jpnWorker, small, 'line'), recognize(jpnWorker, plain, 'line')])));
    }

    // Second look at an unclear nameplate (first read not confident):
    // zoom in closer (6x, 8x) and also read it from the screenshot's own
    // pixels in black and white -- on a blurred name the color filter can
    // cut letters short. Every extra reading goes to the Growth Rate
    // matching, which only accepts a name several readings agree on.
    if (deep || main.confidence < SECOND_LOOK_BELOW) {
      const crops = [
        await renderRun(cls, label, runOf, W, H, run, 6),
        await renderRun(cls, label, runOf, W, H, run, 8),
        await originalCrop(data, W, H, run),
      ];
      for (const crop of crops) {
        // Chinese-only reader: on the original pixels only (it read small Han
        // names best there; on the zooms it mostly repeated itself, slowly).
        const withHan = crop === crops[crops.length - 1];
        all.push(...(await Promise.all([recognize(korWorker, crop, 'line'), recognize(chiWorker, crop, 'line'), ...(withHan ? [recognize(hanWorker, crop, 'line')] : [])])));
      }
    }
    if (process.env.ATTENDANCE_OCR_DEBUG) {
      console.log(`[ocr] x=${run.x0} y=${run.y0} w=${width(run)} h=${height(run)} parts=${run.parts.length}`, all.map((r) => `${JSON.stringify(r.text.trim())}@${Math.round(r.confidence)}`).join(' | '));
    }
    const alternatives = [...new Set(all.map((r) => normalizeName(r.text)).filter(isPlausibleName))];
    // Readings at least two of the six settings agree on, one of them
    // reasonably sure (≥ 50): trustworthy enough for the cut-off-name rule
    // even when they aren't the main reading ("ORM" of a half-hidden STORM
    // whose main reading was just "RM").
    const strong = alternatives.filter((a) => {
      const same = all.filter((r) => normalizeName(r.text) === a);
      return same.length >= 2 && Math.max(...same.map((r) => r.confidence)) >= 50;
    });
    const mainName = normalizeName(main.text);
    const name = isPlausibleName(mainName) ? mainName : alternatives[0];
    if (!name || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    names.push({
      name,
      alternatives: alternatives.filter((a) => a !== name),
      strong,
      color: NAME_COLORS[run.color].color,
      // Found only through the dim-blue fallback: rosterMatch accepts a
      // clear match for it, never a loose guess.
      dim: Boolean(run.dim),
      // Tesseract's own confidence: low usually means an overlapped or
      // effect-covered nameplate -- flagged so someone double-checks it.
      uncertain: main.confidence < 70 || name !== mainName,
    });
  }
  return { names, clearBoxes };
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
