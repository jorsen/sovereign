// Draws the animated "bot online" emoji -- a green dot growing from small
// to full size and back -- as assets/status-online.gif (128x128, loops forever).
// Uploaded once as an emoji of the bot application (see upload-status-emoji.js);
// the attendance guide shows it while the PC bot is on.
//   node make-status-emoji.js
const path = require('path');
const sharp = require('sharp');

const SIZE = 128;
const FRAMES = 24;
const FRAME_MS = 50;
const OUT = path.join(__dirname, 'assets', 'status-online.gif');
const GREEN = '#23a55a';

function frame(i) {
  const t = i / FRAMES; // 0..1 through one pulse
  // The dot grows from small to its normal (full) size and back, eased so
  // it slows at both ends -- a calm "breathing" pulse.
  const ease = (1 - Math.cos(t * Math.PI * 2)) / 2; // 0 -> 1 -> 0
  const dotR = 20 + ease * 40;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
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
