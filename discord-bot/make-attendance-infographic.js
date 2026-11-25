// Draws the "how to log a boss kill" infographic shown in the attendance
// guide (lib/attendanceGuide.js) and saves it to
// public/guide/attendance-guide.png (served by the site, which is where the
// guide embed loads it from). Re-run after changing it, then bump ?v= in
// lib/attendanceGuide.js (Discord caches embed images by URL):
//   node make-attendance-infographic.js
// Same look as make-infographic.js (the /uniongr one). Everything is drawn
// (no emoji: the SVG renderer has no color emoji font).
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const W = 1200;
const H = 1400;
const OUT = path.join(__dirname, '..', 'public', 'guide', 'attendance-guide.png');

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
  party: '#5aa9ff',
  guild: '#3ddc6a',
  alliance: '#a8f0a0',
  scene: '#3a3226',
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
// A tick box: ticked (green with a check) or empty.
const box = (x, y, ticked) =>
  ticked ? rect(x, y, 30, 30, { fill: C.green, r: 6 }) + check(x + 5, y + 3, 0.6, '#fff') : rect(x, y, 30, 30, { fill: 'none', stroke: C.border, sw: 3, r: 6 });

// Step cards: 2 × 2 grid.
const CW = 560;
const CH = 400;
const GX = [30, 610];
const GY = [130, 550];

function card(i, title, body) {
  const x = GX[i % 2];
  const y = GY[Math.floor(i / 2)];
  return `<g>${rect(x, y, CW, CH)}${badge(x + 52, y + 54, String(i + 1))}${text(x + 100, y + 66, title, { size: 34, weight: 800 })}${body(x, y)}</g>`;
}

// A tiny battle screenshot: a scene with colored name tags over figures.
function battleShot(x, y, w, h) {
  const tags = [
    [0.12, 0.3, C.party], [0.5, 0.22, C.guild], [0.72, 0.5, C.alliance], [0.28, 0.62, C.guild], [0.62, 0.78, C.party],
  ];
  return (
    rect(x, y, w, h, { fill: C.scene, r: 8 }) +
    tags
      .map(([fx, fy, color]) => {
        const tx = x + fx * w;
        const ty = y + fy * h;
        return rect(tx, ty, w * 0.24, 9, { fill: color, r: 3 }) + `<circle cx="${tx + w * 0.12}" cy="${ty + 24}" r="8" fill="#8a7a60"/>`;
      })
      .join('')
  );
}
// A tiny loot list screenshot: rows of icon + text.
function lootShot(x, y, w, h) {
  let s = rect(x, y, w, h, { fill: '#26221c', r: 8 });
  for (let i = 0; i < 5; i++) {
    const ry = y + 14 + i * ((h - 20) / 5);
    s += rect(x + 10, ry, 20, 20, { fill: C.gold, r: 4 }) + rect(x + 38, ry + 6, w - 52, 8, { fill: C.muted, r: 3 });
  }
  return s;
}

// 1. Post the screenshots with the boss name in the same message.
const step1 = (x, y) =>
  `<circle cx="${x + 62}" cy="${y + 140}" r="26" fill="${C.blurple}"/>` +
  text(x + 104, y + 132, 'You', { size: 26, weight: 800 }) +
  text(x + 104, y + 166, 'Kafka', { size: 30, weight: 700, fill: C.gold }) +
  text(x + 200, y + 166, '← boss name', { size: 24, weight: 700, fill: C.gold }) +
  battleShot(x + 104, y + 192, 135, 100) +
  battleShot(x + 249, y + 192, 135, 100) +
  lootShot(x + 394, y + 192, 135, 100) +
  text(x + 104, y + 330, 'Battle screenshots', { size: 22, weight: 600, fill: C.muted }) +
  text(x + 394, y + 330, 'Loot list', { size: 22, weight: 600, fill: C.muted }) +
  text(x + 30, y + 378, 'All in ONE message · up to 10 screenshots', { size: 24, weight: 700, fill: C.text });

// 2. The loot list: Time of Death + loot.
function lootRow(x, y, item, n) {
  return (
    rect(x, y, CW - 60, 50, { fill: C.input, r: 8 }) +
    rect(x + 12, y + 10, 30, 30, { fill: C.gold, r: 6 }) +
    text(x + 56, y + 34, '11.20.2026 00:55', { size: 20, weight: 700, fill: C.gold }) +
    text(x + 262, y + 34, item, { size: 21, weight: 600 }) +
    text(x + CW - 80, y + 34, `×${n}`, { size: 22, weight: 700, fill: C.muted, anchor: 'end' })
  );
}
const step2 = (x, y) =>
  lootRow(x + 30, y + 110, 'Higher Seal of Adv.', 2) +
  lootRow(x + 30, y + 170, 'Enhancement Scroll', 5) +
  lootRow(x + 30, y + 230, 'Golden Cape', 1) +
  rect(x + 80, y + 104, 172, 182, { fill: 'none', stroke: C.gold, sw: 4, r: 10 }) +
  text(x + 30, y + 330, 'Gives the exact Time of Death', { size: 26, weight: 700, fill: C.gold }) +
  text(x + 30, y + 368, 'and the loot. Forgot it? Use Add loot.', { size: 24, weight: 500, fill: C.muted });

// 3. Check the Review.
function nameRow(x, y, name, ticked, note) {
  return box(x, y, ticked) + text(x + 46, y + 25, name, { size: 26, weight: 700, fill: ticked ? C.text : C.muted }) + (note ? text(x + 200, y + 25, note, { size: 21, weight: 500, fill: C.gold }) : '');
}
const step3 = (x, y) =>
  rect(x + 30, y + 100, CW - 60, 210, { fill: C.card, stroke: C.blurple, sw: 3, r: 12 }) +
  text(x + 50, y + 138, 'Review · Kafka · 3 to log', { size: 24, weight: 800, fill: C.blurple }) +
  nameRow(x + 50, y + 158, 'Arcturus', true) +
  nameRow(x + 50, y + 200, 'Mochi', true) +
  nameRow(x + 50, y + 242, 'Ry0ga', false, 'not sure: tick if there') +
  text(x + 30, y + 348, 'Untick who wasn\'t there · tick "not sure"', { size: 22, weight: 600, fill: C.muted }) +
  text(x + 30, y + 380, 'Missed someone? Add a missed member', { size: 22, weight: 700, fill: C.text });

// 4. Save, and the marks on your post.
function mark(cx, cy, color, label, inner) {
  return `<circle cx="${cx}" cy="${cy}" r="28" fill="${color}"/>` + inner + text(cx, cy + 62, label, { size: 22, weight: 600, fill: C.muted, anchor: 'middle' });
}
const step4 = (x, y) =>
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
const DY = 975;
function dosAndDonts() {
  const dos = ['Full screen — name tags readable', 'Boss name in the same message', 'Loot list included', 'One kill per message'];
  const donts = ['Cropped or blurry screenshots', 'Screenshots without a boss name', 'Two bosses in one message', 'Boss name in a separate message'];
  let s = rect(30, DY, W - 60, 395) + text(60, DY + 58, 'Do', { size: 38, weight: 800, fill: C.green }) + text(630, DY + 58, "Don't", { size: 38, weight: 800, fill: C.red });
  dos.forEach((t, i) => {
    s += check(60, DY + 100 + i * 72, 0.9) + text(108, DY + 128 + i * 72, t, { size: 27, weight: 600 });
  });
  donts.forEach((t, i) => {
    s += cross(632, DY + 104 + i * 72, 0.9) + text(680, DY + 128 + i * 72, t, { size: 27, weight: 600 });
  });
  return s;
}

(async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${rect(0, 0, W, H, { fill: C.bg, r: 0 })}
  ${text(W / 2, 82, 'How to log a boss kill', { size: 52, weight: 800, anchor: 'middle' })}
  ${card(0, 'Post screenshots + boss', step1)}
  ${card(1, 'Include the loot list', step2)}
  ${card(2, 'Check the Review', step3)}
  ${card(3, 'Press Save', step4)}
  ${dosAndDonts()}
</svg>`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(OUT);
  console.log(`Saved ${OUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
