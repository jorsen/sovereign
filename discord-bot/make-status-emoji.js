// Draws the animated "bot online" emoji -- a green dot with a ring pulsing
// out of it -- as assets/status-online.gif (128x128, loops forever).
// Uploaded once as an emoji of the bot application (see upload-status-emoji.js);
// the attendance guide shows it while the PC bot is on.
//   node make-status-emoji.js
const path = require('path');
const sharp = require('sharp');

const SIZE = 128;
const FRAMES = 18;
const FRAME_MS = 70;
const OUT = path.join(__dirname, 'assets', 'status-online.gif');
const GREEN = '#23a55a';

function frame(i) {
  const t = i / FRAMES; // 0..1 through one pulse
  // Big moves, so the pulse still shows at emoji size (~22 px in a message):
  // the dot swells and shrinks, and a thick ring shoots out to the edge,
  // thinning as it goes (a GIF has no half-transparent pixels to fade with).
  const ringR = 34 + t * 28;
  const ringWidth = (16 * (1 - t)).toFixed(2);
  const dotR = 34 + Math.sin(t * Math.PI * 2) * 12;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    ${t < 0.92 ? `<circle cx="64" cy="64" r="${ringR}" fill="none" stroke="${GREEN}" stroke-width="${ringWidth}"/>` : ''}
    <circle cx="64" cy="64" r="${dotR}" fill="${GREEN}"/>
    <circle cx="${64 - dotR * 0.3}" cy="${64 - dotR * 0.3}" r="${dotR * 0.28}" fill="#ffffff" fill-opacity="0.35"/>
  </svg>`);
}

(async () => {
  const frames = await Promise.all(Array.from({ length: FRAMES }, (_, i) => sharp(frame(i)).png().toBuffer()));
  await sharp(frames, { join: { animated: true } })
    .gif({ delay: Array(FRAMES).fill(FRAME_MS), loop: 0 })
    .toFile(OUT);
  const meta = await sharp(OUT, { animated: true }).metadata();
  console.log(`Saved ${OUT} (${meta.pages} frames, ${meta.size} bytes)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
