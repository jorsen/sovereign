// Draws the /uniongr infographic shown at the bottom of the pinned guide and
// saves it to public/guide/uniongr-guide.png (served by the site, which is
// where the guide embed loads it from). Re-run after changing it:
//   node make-infographic.js
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const W = 1200;
const H = 1530;
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

// Screenshot section: a real correct screenshot (assets/correct-screenshot.png)
// next to the "wrong" version -- the same image cropped down to just the
// Character Details popup. Both are embedded in the SVG as data URIs.
const SY = 960;
const SHOT = path.join(__dirname, 'assets', 'correct-screenshot.png');
// Where the popup and the Growth Rate box sit in the source image (1470×917).
const POPUP_CROP = { left: 15, top: 70, width: 335, height: 560 };
const GR_BOX = { x: 48, y: 305, w: 274, h: 36 };

function imageTag(x, y, w, h, dataUri, id) {
  return (
    `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/></clipPath>` +
    `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" clip-path="url(#${id})" href="${dataUri}" xlink:href="${dataUri}"/>`
  );
}

async function screenshotSection() {
  const meta = await sharp(SHOT).metadata();
  const full = `data:image/png;base64,${(await sharp(SHOT).png().toBuffer()).toString('base64')}`;
  const cropped = `data:image/png;base64,${(await sharp(SHOT).extract(POPUP_CROP).png().toBuffer()).toString('base64')}`;

  const gw = 600;
  const gh = Math.round((gw * meta.height) / meta.width);
  const gx = 60;
  const gy = SY + 90;
  const k = gw / meta.width;

  const bh = gh;
  const bw = Math.round((bh * POPUP_CROP.width) / POPUP_CROP.height);
  const bx = 690;
  const by = gy;
  const tx = bx + bw + 24;

  return (
    rect(30, SY, W - 60, 540) +
    text(60, SY + 60, 'Your screenshot', { size: 38, weight: 800 }) +
    imageTag(gx, gy, gw, gh, full, 'clipGood') +
    rect(gx, gy, gw, gh, { fill: 'none', stroke: C.green, sw: 6, r: 10 }) +
    // point at the Growth Rate number
    rect(gx + GR_BOX.x * k - 6, gy + GR_BOX.y * k - 6, GR_BOX.w * k + 12, GR_BOX.h * k + 12, { fill: 'none', stroke: C.gold, sw: 4, r: 8 }) +
    check(gx, gy + gh + 22, 0.9) +
    text(gx + 42, gy + gh + 48, 'Full screen · landscape · Growth Rate visible', { size: 24, weight: 700, fill: C.green }) +
    imageTag(bx, by, bw, bh, cropped, 'clipBad') +
    rect(bx, by, bw, bh, { fill: 'none', stroke: C.red, sw: 6, r: 10 }) +
    text(tx, by + 60, 'Cropped popup', { size: 26, weight: 700 }) +
    text(tx, by + 100, 'Tall / portrait', { size: 26, weight: 700 }) +
    text(tx, by + 140, 'Blurry numbers', { size: 26, weight: 700 }) +
    cross(bx, by + bh + 22, 0.9) +
    text(bx + 40, by + bh + 48, 'Rejected', { size: 26, weight: 800, fill: C.red })
  );
}

(async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${rect(0, 0, W, H, { fill: C.bg, r: 0 })}
  ${text(W / 2, 82, 'How to submit your Growth Rate', { size: 52, weight: 800, anchor: 'middle' })}
  ${card(0, 'Type /uniongr', step1)}
  ${card(1, 'Pick an option', step2)}
  ${card(2, 'Fill in the fields', step3)}
  ${card(3, 'Send it', step4)}
  ${await screenshotSection()}
</svg>`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(OUT);
  console.log(`Saved ${OUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
