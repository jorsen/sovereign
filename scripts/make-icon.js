// Builds assets/sovereign.ico (the "Sovereign" shortcuts and installer):
// the site's dark tile and gold, with an "S" so it can't be mixed up with
// Capital Records' "CR" on the desktop. One PNG per size Windows uses,
// packed into an .ico container.
//   node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0a0f1a"/>
  <rect x="1.5" y="1.5" width="61" height="61" rx="12.5" fill="none" stroke="#f2a93c" stroke-opacity="0.35" stroke-width="2"/>
  <text x="32" y="46" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="42" font-weight="700" fill="#f2a93c">S</text>
</svg>`);
const out = path.join(__dirname, '..', 'assets', 'sovereign.ico');

(async () => {
  const pngs = [];
  for (const size of SIZES) pngs.push(await sharp(svg, { density: Math.max(72, (72 * size) / 64 * 2) }).resize(size, size).png().toBuffer());
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((png, i) => {
    const size = SIZES[i];
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2); // no palette
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4); // color planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  fs.writeFileSync(out, Buffer.concat([header, dir, ...pngs]));
  console.log(`Wrote ${out} (${SIZES.join(', ')} px)`);
})();
