// Generates the simple toolbar icons in static/icons without image tooling dependencies.
// Run once: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      // Square tile background
      let rgba = [0, 0, 0, 0];
      const inTile = Math.max(Math.abs(dx), Math.abs(dy)) < c * 0.94;
      if (inTile) rgba = [26, 115, 232, 255];
      // Magnifier ring
      const mx = dx + c * 0.12, my = dy + c * 0.12;
      const mr = Math.hypot(mx, my) / c;
      if (inTile && mr > 0.36 && mr < 0.54) rgba = [255, 255, 255, 255];
      // Handle
      const hx = dx - c * 0.36, hy = dy - c * 0.36;
      if (inTile && Math.abs(hx - hy) < c * 0.16 && hx > -c * 0.12 && hx < c * 0.3) rgba = [255, 255, 255, 255];
      // Head dot inside the ring
      if (inTile && mr < 0.2) rgba = [255, 255, 255, 255];
      raw.set(rgba, i);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('static/icons', { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`static/icons/icon${s}.png`, png(s));
console.log('icons written');
