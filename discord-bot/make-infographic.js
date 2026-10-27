// Draws the /uniongr infographic shown at the bottom of the pinned guide and
// saves it to public/guide/uniongr-guide.png (served by the site, which is
// where the guide embed loads it from). Re-run after changing it:
//   node make-infographic.js
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const W = 1200;
const H = 1440;
const OUT = path.join(__dirname, '..', 'public', 'guide', 'uniongr-guide.png');

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
const FONT = "Segoe UI, Arial, sans-serif";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, s, { size = 30, fill = C.text, weight = 600, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const rect = (x, y, w, h, { fill = C.card, stroke = 'none', sw = 0, r = 16 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const badge = (x, y, n) => `<circle cx="${x}" cy="${y}" r="30" fill="${C.green}"/>` + text(x, y + 12, n, { size: 34, weight: 800, anchor: 'middle' });
const check = (x, y, s = 1, color = C.green) =>
  `<path d="M${x} ${y + 14 * s} l${12 * s} ${12 * s} l${24 * s} -${26 * s}" fill="none" stroke="${color}" stroke-width="${7 * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
const cross = (x, y, s = 1) =>
  `<path d="M${x} ${y} l${26 * s} ${26 * s} M${x + 26 * s} ${y} l-${26 * s} ${26 * s}" stroke="${C.red}" stroke-width="${7 * s}" stroke-linecap="round"/>`;

// Step cards: 2 × 2 grid.
const CW = 560;
const CH = 380;
const GX = [30, 610];
const GY = [130, 540];

function card(i, title, body) {
  const x = GX[i % 2];
  const y = GY[Math.floor(i / 2)];
  return `<g>${rect(x, y, CW, CH)}${badge(x + 52, y + 54, String(i + 1))}${text(x + 100, y + 66, title, { size: 36, weight: 800 })}${body(x, y)}</g>`;
}

// 1. Type /uniongr and click it in the pop-up.
const step1 = (x, y) =>
  rect(x + 30, y + 110, CW - 60, 170, { fill: C.card, stroke: C.border, sw: 2, r: 10 }) +
  rect(x + 40, y + 120, CW - 80, 70, { fill: C.blurple, r: 8 }) +
  text(x + 60, y + 166, '/uniongr same-ign', { size: 30, weight: 700 }) +
  text(x + 60, y + 245, '/uniongr switched-ign', { size: 30, weight: 600, fill: C.muted }) +
  rect(x + 30, y + 296, CW - 60, 62, { fill: C.input, r: 10 }) +
  text(x + 50, y + 338, '/uniongr', { size: 30, weight: 700 }) +
  // mouse pointer on the highlighted option
  `<path d="M${x + 440} ${y + 140} l0 52 l14 -13 l11 24 l10 -5 l-11 -23 l19 -1 z" fill="#fff" stroke="#000" stroke-width="2"/>`;

// 2. Which option.
const step2 = (x, y) =>
  rect(x + 30, y + 110, CW - 60, 110, { fill: C.input, stroke: C.green, sw: 3, r: 12 }) +
  text(x + 55, y + 158, 'same-ign', { size: 34, weight: 800, fill: C.green }) +
  text(x + 55, y + 200, 'Same IGN / first time — most people', { size: 26, weight: 500, fill: C.muted }) +
  rect(x + 30, y + 240, CW - 60, 110, { fill: C.input, stroke: C.gold, sw: 3, r: 12 }) +
  text(x + 55, y + 288, 'switched-ign', { size: 34, weight: 800, fill: C.gold }) +
  text(x + 55, y + 330, 'Only if you renamed — admin approves', { size: 26, weight: 500, fill: C.muted });

// 3. Fill in the fields.
function field(x, y, name, value, opts = {}) {
  return (
    rect(x, y, CW - 60, 62, { fill: C.input, r: 10 }) +
    text(x + 20, y + 42, name, { size: 28, weight: 700, fill: opts.nameFill || C.text }) +
    text(x + 230, y + 42, value, { size: 28, weight: 500, fill: opts.valueFill || C.muted })
  );
}
const step3 = (x, y) =>
  field(x + 30, y + 105, 'ign', 'pick your name ▾') +
  field(x + 30, y + 177, 'growthrate', '678910') +
  field(x + 30, y + 249, 'screenshot', '+ attach image', { valueFill: C.blurple }) +
  text(x + 30, y + 355, 'class · guild · lamp — leave empty to keep', { size: 24, weight: 500, fill: C.muted });

// 4. Send and check the private reply.
const step4 = (x, y) =>
  rect(x + 30, y + 110, CW - 60, 90, { fill: C.input, r: 10 }) +
  text(x + 50, y + 168, 'Press', { size: 32, weight: 600, fill: C.muted }) +
  rect(x + 150, y + 128, 140, 54, { fill: C.card, stroke: C.border, sw: 2, r: 8 }) +
  text(x + 220, y + 166, 'Enter', { size: 28, weight: 800, anchor: 'middle' }) +
  rect(x + 30, y + 225, CW - 60, 125, { fill: C.card, stroke: C.green, sw: 3, r: 12 }) +
  `<circle cx="${x + 80}" cy="${y + 287}" r="28" fill="${C.green}"/>` +
  check(x + 62, y + 270, 1, '#fff') +
  text(x + 130, y + 280, 'Saved', { size: 34, weight: 800, fill: C.green }) +
  text(x + 130, y + 320, 'Only you can see this reply', { size: 24, weight: 500, fill: C.muted });

// Screenshot section: correct vs wrong.
const SY = 960;
function landscapeShot(x, y) {
  const w = 520;
  const h = 292;
  return (
    rect(x, y, w, h, { fill: '#0f1a24', stroke: C.green, sw: 6, r: 10 }) +
    // character silhouette
    `<circle cx="${x + 120}" cy="${y + 100}" r="34" fill="#4b6a85"/>` +
    `<path d="M${x + 70} ${y + 250} q50 -130 100 0 z" fill="#4b6a85"/>` +
    // Character Details / Artifacts panel
    rect(x + 250, y + 30, 245, 232, { fill: '#22303d', stroke: '#5b7287', sw: 2, r: 8 }) +
    text(x + 268, y + 66, 'Character Details', { size: 22, weight: 700 }) +
    rect(x + 268, y + 82, 105, 34, { fill: C.gold, r: 6 }) +
    text(x + 320, y + 107, 'Artifacts', { size: 20, weight: 800, fill: '#1e1f22', anchor: 'middle' }) +
    text(x + 268, y + 158, 'Growth Rate', { size: 22, weight: 500, fill: C.muted }) +
    text(x + 268, y + 194, '678,910', { size: 32, weight: 800, fill: C.gold }) +
    text(x + 268, y + 240, 'Volcano Lamp +12', { size: 22, weight: 600, fill: C.text })
  );
}
function croppedShot(x, y) {
  return (
    rect(x, y, 170, 292, { fill: '#22303d', stroke: C.red, sw: 6, r: 10 }) +
    text(x + 85, y + 60, 'popup', { size: 22, weight: 600, fill: C.muted, anchor: 'middle' }) +
    text(x + 85, y + 90, 'only', { size: 22, weight: 600, fill: C.muted, anchor: 'middle' }) +
    text(x + 85, y + 160, '678,910', { size: 26, weight: 800, fill: C.gold, anchor: 'middle' })
  );
}

const screenshotSection =
  rect(30, SY, W - 60, 450) +
  text(60, SY + 60, 'Your screenshot', { size: 38, weight: 800 }) +
  landscapeShot(60, SY + 90) +
  `<circle cx="${120}" cy="${SY + 405}" r="0"/>` +
  check(60, SY + 392, 0.9) +
  text(100, SY + 418, 'Full screen · landscape · Artifacts tab', { size: 24, weight: 700, fill: C.green }) +
  croppedShot(680, SY + 90) +
  text(870, SY + 150, 'Cropped popup', { size: 28, weight: 700, fill: C.text }) +
  text(870, SY + 190, 'Tall / portrait image', { size: 28, weight: 700, fill: C.text }) +
  text(870, SY + 230, 'Blurry or cut-off', { size: 28, weight: 700, fill: C.text }) +
  text(870, SY + 270, 'numbers', { size: 28, weight: 700, fill: C.text }) +
  cross(680, SY + 395, 0.9) +
  text(720, SY + 418, 'Rejected', { size: 26, weight: 800, fill: C.red });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${rect(0, 0, W, H, { fill: C.bg, r: 0 })}
  ${text(W / 2, 82, 'How to submit your Growth Rate', { size: 52, weight: 800, anchor: 'middle' })}
  ${card(0, 'Type /uniongr', step1)}
  ${card(1, 'Pick an option', step2)}
  ${card(2, 'Fill in the fields', step3)}
  ${card(3, 'Send it', step4)}
  ${screenshotSection}
</svg>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
sharp(Buffer.from(svg))
  .png()
  .toFile(OUT)
  .then(() => console.log(`Saved ${OUT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
