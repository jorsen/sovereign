// Draws the "how to log a boss kill" infographic shown in the attendance
// guide (lib/attendanceGuide.js) and saves it to
// public/guide/attendance-guide.png (served by the site, which is where the
// guide embed loads it from). Re-run after changing it, then bump ?v= in
// lib/attendanceGuide.js (Discord caches embed images by URL):
//   node make-attendance-infographic.js
// Same look as make-infographic.js (the /uniongr one). Step 1 uses a real
// post's screenshots (assets/attendance-battle.jpg, assets/attendance-loot.jpg
// -- an Awakened Panderre kill); the rest is drawn (no emoji: the SVG renderer has no
// color emoji font).
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const W = 1200;
const H = 1560;
const OUT = path.join(__dirname, '..', 'public', 'guide', 'attendance-guide.png');
const BATTLE = path.join(__dirname, 'assets', 'attendance-battle.jpg');
const LOOT = path.join(__dirname, 'assets', 'attendance-loot.jpg');
// Where to point, as fractions of each image: the name tags on the battle
// screenshot, the Obtainment Time column on the loot list.
const NAME_TAGS = { x: 0.085, y: 0.245, w: 0.57, h: 0.34 };
const TIME_COLUMN = { x: 0.535, y: 0.18, w: 0.175, h: 0.79 };

const C = {
  bg: '#1e1f22',
  card: '#2b2d31',
  input: '#383a40',
  border: '#4e5058',
  text: '#f2f3f5',
  muted: '#b5bac1',
  green: '#23a55a',
  red: '#f23f43',
  blurple: '#5865f2',
  gold: '#f0b232',
};
const FONT = 'Segoe UI, Arial, sans-serif';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, s, { size = 30, fill = C.text, weight = 600, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const rect = (x, y, w, h, { fill = C.card, stroke = 'none', sw = 0, r = 16 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const badge = (x, y, n) => `<circle cx="${x}" cy="${y}" r="30" fill="${C.gold}"/>` + text(x, y + 12, n, { size: 34, weight: 800, anchor: 'middle', fill: '#1e1f22' });
const check = (x, y, s = 1, color = C.green) =>
  `<path d="M${x} ${y + 14 * s} l${12 * s} ${12 * s} l${24 * s} -${26 * s}" fill="none" stroke="${color}" stroke-width="${7 * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
const cross = (x, y, s = 1) =>
  `<path d="M${x} ${y} l${26 * s} ${26 * s} M${x + 26 * s} ${y} l-${26 * s} ${26 * s}" stroke="${C.red}" stroke-width="${7 * s}" stroke-linecap="round"/>`;
const box = (x, y, ticked) =>
  ticked ? rect(x, y, 30, 30, { fill: C.green, r: 6 }) + check(x + 5, y + 3, 0.6, '#fff') : rect(x, y, 30, 30, { fill: 'none', stroke: C.border, sw: 3, r: 6 });
const imageTag = (x, y, w, h, dataUri, id) =>
  `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/></clipPath>` +
  `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" clip-path="url(#${id})" href="${dataUri}" xlink:href="${dataUri}"/>`;
const highlight = (x, y, w, h, area) => rect(x + area.x * w, y + area.y * h, area.w * w, area.h * h, { fill: 'none', stroke: C.gold, sw: 5, r: 10 });

async function dataUri(file) {
  const meta = await sharp(file).metadata();
  return { uri: `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`, ratio: meta.width / meta.height };
}

// 1. A real post: the boss name in the message, both screenshots attached.
const PY = 130;
async function postSection() {
  const battle = await dataUri(BATTLE);
  const loot = await dataUri(LOOT);
  // The battle shot big on the left; the (wide, short) loot list on the
  // right, each with its caption underneath.
  const gap = 24;
  const left = 60;
  const y = PY + 200;
  const bw = 560;
  const h = Math.round(bw / battle.ratio);
  const lx = left + bw + gap;
  const lw = W - left - lx;
  const lh = Math.round(lw / loot.ratio);
  return (
    rect(30, PY, W - 60, 620) +
    badge(82, PY + 54, '1') +
    text(130, PY + 66, 'Post the screenshots with the boss name', { size: 36, weight: 800 }) +
    // the message itself
    `<circle cx="${left + 26}" cy="${PY + 140}" r="26" fill="${C.blurple}"/>` +
    text(left + 68, PY + 132, 'You', { size: 26, weight: 800 }) +
    text(left + 68, PY + 170, 'Awakened Panderre', { size: 32, weight: 700, fill: C.gold }) +
    text(left + 400, PY + 168, '← boss name, in the SAME message', { size: 25, weight: 700, fill: C.gold }) +
    imageTag(left, y, bw, h, battle.uri, 'clipBattle') +
    highlight(left, y, bw, h, NAME_TAGS) +
    check(left, y + h + 20, 0.8) +
    text(left + 40, y + h + 44, 'Battle screenshot: full screen,', { size: 23, weight: 700, fill: C.green }) +
    text(left + 40, y + h + 74, 'name tags readable', { size: 23, weight: 700, fill: C.green }) +
    imageTag(lx, y, lw, lh, loot.uri, 'clipLoot') +
    highlight(lx, y, lw, lh, TIME_COLUMN) +
    check(lx, y + lh + 20, 0.8) +
    text(lx + 40, y + lh + 44, 'Loot list: its Obtainment Time', { size: 23, weight: 700, fill: C.green }) +
    text(lx + 40, y + lh + 74, 'becomes the Time of Death', { size: 23, weight: 700, fill: C.green }) +
    text(lx, y + lh + 124, 'All in one message', { size: 22, weight: 500, fill: C.muted }) +
    text(lx, y + lh + 156, 'Up to 10 screenshots', { size: 22, weight: 500, fill: C.muted }) +
    text(lx, y + lh + 188, 'Big fights: add more angles', { size: 22, weight: 500, fill: C.muted })
  );
}

// 2 and 3: cards side by side.
const CW = 560;
const CH = 400;
const CY = 770;
function card(x, n, title, body) {
  return `<g>${rect(x, CY, CW, CH)}${badge(x + 52, CY + 54, n)}${text(x + 100, CY + 66, title, { size: 34, weight: 800 })}${body(x, CY)}</g>`;
}

function nameRow(x, y, name, ticked, note) {
  return box(x, y, ticked) + text(x + 46, y + 25, name, { size: 26, weight: 700, fill: ticked ? C.text : C.muted }) + (note ? text(x + 200, y + 25, note, { size: 21, weight: 500, fill: C.gold }) : '');
}
const review = (x, y) =>
  rect(x + 30, y + 100, CW - 60, 210, { fill: C.card, stroke: C.blurple, sw: 3, r: 12 }) +
  text(x + 50, y + 138, 'Review · Awakened Panderre · 3 to log', { size: 24, weight: 800, fill: C.blurple }) +
  nameRow(x + 50, y + 158, 'AyaNinna', true) +
  nameRow(x + 50, y + 200, 'STORM', true) +
  nameRow(x + 50, y + 242, 'Potpot', false, 'not sure: tick if there') +
  text(x + 30, y + 348, 'Untick who wasn\'t there · tick "not sure"', { size: 22, weight: 600, fill: C.muted }) +
  text(x + 30, y + 380, 'Missed someone? Add a missed member', { size: 22, weight: 700, fill: C.text });

function mark(cx, cy, color, label, inner) {
  return `<circle cx="${cx}" cy="${cy}" r="28" fill="${color}"/>` + inner + text(cx, cy + 62, label, { size: 22, weight: 600, fill: C.muted, anchor: 'middle' });
}
const save = (x, y) =>
  rect(x + 30, y + 110, 220, 64, { fill: C.green, r: 10 }) +
  text(x + 140, y + 152, 'Save', { size: 30, weight: 800, anchor: 'middle' }) +
  rect(x + 270, y + 110, 220, 64, { fill: C.input, r: 10 }) +
  text(x + 380, y + 152, 'Cancel', { size: 30, weight: 700, anchor: 'middle', fill: C.muted }) +
  text(x + 30, y + 214, 'Only the poster or an admin', { size: 22, weight: 500, fill: C.muted }) +
  mark(x + 90, y + 280, C.blurple, 'reading', `<circle cx="${x + 86}" cy="${y + 276}" r="11" fill="none" stroke="#fff" stroke-width="5"/><path d="M${x + 94} ${y + 284} l10 10" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`) +
  text(x + 165, y + 290, '→', { size: 34, weight: 800, fill: C.muted, anchor: 'middle' }) +
  mark(x + 240, y + 280, C.gold, 'Review', rect(x + 228, y + 262, 24, 34, { fill: '#fff', r: 3 })) +
  text(x + 315, y + 290, '→', { size: 34, weight: 800, fill: C.muted, anchor: 'middle' }) +
  mark(x + 390, y + 280, C.green, 'saved', check(x + 372, y + 262, 0.9, '#fff'));

// Do / Don't.
const DY = 1190;
function dosAndDonts() {
  const dos = ['Full screen — name tags readable', 'Boss name in the same message', 'Loot list included', 'One kill per message'];
  const donts = ['Cropped or blurry screenshots', 'Screenshots without a boss name', 'Two bosses in one message', 'Boss name in a separate message'];
  let s = rect(30, DY, W - 60, 340) + text(60, DY + 56, 'Do', { size: 36, weight: 800, fill: C.green }) + text(630, DY + 56, "Don't", { size: 36, weight: 800, fill: C.red });
  dos.forEach((t, i) => {
    s += check(60, DY + 92 + i * 62, 0.85) + text(106, DY + 118 + i * 62, t, { size: 26, weight: 600 });
  });
  donts.forEach((t, i) => {
    s += cross(632, DY + 96 + i * 62, 0.85) + text(678, DY + 118 + i * 62, t, { size: 26, weight: 600 });
  });
  return s;
}

(async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${rect(0, 0, W, H, { fill: C.bg, r: 0 })}
  ${text(W / 2, 82, 'How to log a boss kill', { size: 52, weight: 800, anchor: 'middle' })}
  ${await postSection()}
  ${card(30, '2', 'Check the Review', review)}
  ${card(610, '3', 'Press Save', save)}
  ${dosAndDonts()}
</svg>`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(OUT);
  console.log(`Saved ${OUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
