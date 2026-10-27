// Renders the PNG icons from the same geometry as icons/icon.svg. No dependencies.
// Usage: node scripts/icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BG = [0x17, 0x17, 0x1a];
const STEM = [0xff, 0xff, 0xff];
const DOT = [0xc9, 0x45, 0x2d];
const SS = 4; // supersamples per axis

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function inRoundRect(px, py, { x, y, w, h, r }) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}
function inCircle(px, py, { cx, cy, r }) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function render(size) {
  const u = size / 512;
  const stem = { x: 226 * u, y: 200 * u, w: 60 * u, h: 200 * u, r: 14 * u };
  const dot = { cx: 256 * u, cy: 140 * u, r: 38 * u };
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const c = inCircle(px, py, dot) ? DOT : inRoundRect(px, py, stem) ? STEM : BG;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = y * stride + 1 + x * 3;
      const n = SS * SS;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
    }
  }
  return png(size, raw);
}

const out = [
  ["icons/icon-192.png", 192],
  ["icons/icon-512.png", 512],
  ["icons/apple-touch-icon.png", 180],
  ["extension/icon-128.png", 128],
];
for (const [file, size] of out) {
  writeFileSync(join(root, file), render(size));
  console.log(`${file}  ${size}x${size}`);
}
