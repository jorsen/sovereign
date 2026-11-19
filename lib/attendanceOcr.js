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
function classifyPixels(data, pixelCount, toleranceFactor) {
  const cls = new Int8Array(pixelCount).fill(-1);
  const tol2 = NAME_COLORS.map((c) => (c.tolerance * toleranceFactor) ** 2);
  for (let p = 0, i = 0; p < pixelCount; p++, i += 3) {
    for (let t = 0; t < NAME_COLORS.length; t++) {
      const [r, g, b] = NAME_COLORS[t].rgb;
      const dr = data[i] - r, dg = data[i + 1] - g, db = data[i + 2] - b;
      if (dr * dr + dg * dg + db * db < tol2[t]) {
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
async function segment(base, scale, toleranceFactor, maxSize = 1) {
  let data = base.data, W = base.info.width, H = base.info.height;
  if (scale !== 1) {
    const out = await sharp(base.data, { raw: base.info })
      .resize({ width: Math.round(W * scale), kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    [data, W, H] = [out.data, out.info.width, out.info.height];
  }
  const cls = classifyPixels(data, W * H, toleranceFactor);
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
async function segmentAtTextSize(base, toleranceFactor) {
  const probe = await segment(base, 1, toleranceFactor, 3);
  let scale;
  if (probe.textHeight) {
    scale = Math.abs(probe.textHeight / TARGET_TEXT_HEIGHT - 1) <= 0.2 ? 1 : TARGET_TEXT_HEIGHT / probe.textHeight;
  } else {
    scale = Math.abs(REFERENCE_WIDTH / base.info.width - 1) <= 0.1 ? 1 : REFERENCE_WIDTH / base.info.width;
  }
  return segment(base, scale, toleranceFactor);
}

async function readNamesFromScreenshot(buffer) {
  const meta = await sharp(buffer).metadata();
  const base = await sharp(buffer).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lossy = meta.format === 'jpeg' || meta.format === 'webp';
  const { W, H, cls, label, candidates } = await segmentAtTextSize(base, lossy ? LOSSY_TOLERANCE_FACTOR : 1);
  // Which nameplate each glyph belongs to. Only real nameplates count: bits
  // that formed a tiny run of their own (the broken-off stroke of a 4) are
  // still drawn into whichever nameplate they sit in.
  const runOf = new Map();
  for (const run of candidates) for (const part of run.parts) runOf.set(part.id, run);

  const [korWorker, chiWorker] = await getWorkers();
  const seen = new Set();
  const names = [];
  for (const run of candidates) {
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
