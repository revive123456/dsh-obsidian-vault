#!/usr/bin/env node
/**
 * Generate the demo attachment image with zero dependencies (node:zlib only).
 *
 * The demo vault embeds `attachments/demo-attachment.png` from
 * `Notes/Screenshot paste.md`; we generate it instead of committing a binary
 * that cannot be reviewed. Output: tools/demo/vault/attachments/demo-attachment.png
 *
 * Usage: node tools/demo/make-demo-image.mjs [outPath]
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2]
  ? resolve(process.argv[2])
  : join(here, "vault", "attachments", "demo-attachment.png");

const W = 640;
const H = 360;

// ── tiny PNG encoder (RGBA, 8-bit, one IDAT) ────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(pixels, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── draw: dark card, glow, bars, chart line ─────────────────────────────────
const px = Buffer.alloc(W * H * 4);

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const TOP = hex("#0b1220");
const BOTTOM = hex("#1b2740");
const ACCENT = hex("#7c9cff");
const ACCENT2 = hex("#38d9a9");
const ACCENT3 = hex("#ffd166");

function put(x, y, rgb, alpha = 1) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const a = Math.max(0, Math.min(1, alpha));
  px[i] = Math.round(px[i] * (1 - a) + rgb[0] * a);
  px[i + 1] = Math.round(px[i + 1] * (1 - a) + rgb[1] * a);
  px[i + 2] = Math.round(px[i + 2] * (1 - a) + rgb[2] * a);
  px[i + 3] = 255;
}

// background gradient + vignette
for (let y = 0; y < H; y += 1) {
  const t = y / (H - 1);
  for (let x = 0; x < W; x += 1) {
    const dx = (x / W - 0.5) * 1.6;
    const dy = y / H - 0.5;
    const glow = Math.max(0, 1 - Math.hypot(dx, dy) * 1.35) ** 2;
    const r = TOP[0] + (BOTTOM[0] - TOP[0]) * t + 30 * glow;
    const g = TOP[1] + (BOTTOM[1] - TOP[1]) * t + 36 * glow;
    const b = TOP[2] + (BOTTOM[2] - TOP[2]) * t + 64 * glow;
    put(x, y, [r, g, b], 1);
  }
}

// rounded rectangle helper
function roundRect(x0, y0, w0, h0, radius, rgb, alpha = 1) {
  for (let y = y0; y < y0 + h0; y += 1) {
    for (let x = x0; x < x0 + w0; x += 1) {
      const cx = x < x0 + radius ? x0 + radius : x >= x0 + w0 - radius ? x0 + w0 - radius - 1 : x;
      const cy = y < y0 + radius ? y0 + radius : y >= y0 + h0 - radius ? y0 + h0 - radius - 1 : y;
      if (Math.hypot(x - cx, y - cy) <= radius) put(x, y, rgb, alpha);
    }
  }
}

// header bar
roundRect(36, 28, 568, 44, 10, [26, 36, 58], 0.95);
roundRect(52, 44, 120, 12, 6, ACCENT, 0.9);
roundRect(184, 44, 72, 12, 6, [255, 255, 255], 0.22);
roundRect(268, 44, 96, 12, 6, [255, 255, 255], 0.14);

// sidebar strip
roundRect(36, 86, 148, 240, 10, [18, 26, 44], 0.9);
for (let i = 0; i < 6; i += 1) {
  const yy = 104 + i * 28;
  roundRect(52, yy, 12, 12, 4, i === 1 ? ACCENT : [255, 255, 255], i === 1 ? 0.95 : 0.18);
  roundRect(72 + (i % 2) * 10, yy, 82 - (i % 2) * 14, 12, 6, [255, 255, 255], 0.16);
}

// chart card
roundRect(200, 86, 404, 126, 10, [22, 31, 52], 0.95);
const bars = [
  [224, 0.42, ACCENT],
  [280, 0.66, ACCENT2],
  [336, 0.52, ACCENT],
  [392, 0.84, ACCENT3],
  [448, 0.61, ACCENT2],
  [504, 0.95, ACCENT],
];
for (const [x, frac, colour] of bars) {
  const h = Math.round(84 * frac);
  roundRect(x, 190 - h, 34, h, 6, colour, 0.9);
}
for (let y = 120; y <= 186; y += 22) {
  for (let x = 212; x < 592; x += 8) put(x, y, [255, 255, 255], 0.07);
}

// text-ish lines
roundRect(200, 226, 260, 14, 7, [255, 255, 255], 0.28);
roundRect(200, 250, 390, 10, 5, [255, 255, 255], 0.14);
roundRect(200, 270, 330, 10, 5, [255, 255, 255], 0.12);
roundRect(200, 290, 360, 10, 5, [255, 255, 255], 0.10);

// footer pills
roundRect(200, 314, 96, 18, 9, ACCENT, 0.35);
roundRect(308, 314, 76, 18, 9, ACCENT2, 0.32);
roundRect(396, 314, 110, 18, 9, [255, 255, 255], 0.10);

// frame border
for (let x = 0; x < W; x += 1) {
  put(x, 0, [255, 255, 255], 0.05);
  put(x, H - 1, [255, 255, 255], 0.05);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePng(px, W, H));
console.log(`wrote ${out} (${W}x${H})`);
