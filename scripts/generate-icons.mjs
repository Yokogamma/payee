/**
 * PWA icon generator (Phase 8 / M10). No native deps: encodes PNGs directly
 * (zlib + hand-rolled chunks). The glyph is the app's ∞ — two overlapping
 * rings — in the accent color on the app background.
 *
 * Outputs (public/):
 *   icon-192.png            192×192, purpose "any" (rounded corners)
 *   icon-512.png            512×512, purpose "any" (rounded corners)
 *   icon-512-maskable.png   512×512, purpose "maskable" — FULL-BLEED bg,
 *                           glyph inside the 80% safe zone
 *   apple-touch-icon.png    180×180, full-bleed (iOS applies its own mask)
 *
 * Run: node scripts/generate-icons.mjs   (outputs are committed)
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = [0x0a, 0x0a, 0x0f]; // --bg
const FG = [0x6c, 0x63, 0xff]; // --accent

// ── PNG encoding ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  // filter 0 per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing ──────────────────────────────────────────────────────────
/** Antialiased coverage of a ring |dist(c) - r| ≤ w at point (x,y). */
function ringCoverage(x, y, cx, cy, r, w) {
  const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
  return Math.max(0, Math.min(1, w - d + 0.5));
}

function drawIcon(size, { glyphScale, rounded }) {
  const px = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const r = size * glyphScale * 0.24;       // ring radius
  const w = Math.max(1.5, size * glyphScale * 0.075); // half stroke width
  const dx = r * 0.95;                      // ring center offset from middle
  const cornerR = rounded ? size * 0.2 : 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Rounded-corner alpha for "any" icons (maskable stays full-bleed).
      let alpha = 255;
      if (cornerR > 0) {
        const qx = Math.max(Math.abs(x + 0.5 - half) - (half - cornerR), 0);
        const qy = Math.max(Math.abs(y + 0.5 - half) - (half - cornerR), 0);
        const outside = Math.hypot(qx, qy) - cornerR;
        alpha = Math.round(255 * Math.max(0, Math.min(1, 0.5 - outside)));
      }

      const cov = Math.max(
        ringCoverage(x + 0.5, y + 0.5, half - dx, half, r, w),
        ringCoverage(x + 0.5, y + 0.5, half + dx, half, r, w),
      );

      px[i] = Math.round(BG[0] + (FG[0] - BG[0]) * cov);
      px[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * cov);
      px[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * cov);
      px[i + 3] = alpha;
    }
  }
  return encodePNG(size, px);
}

// The glyph's total width ≈ size * glyphScale * 1.09 — keep scales such that
// the ∞ stays comfortably inside the icon (and inside the maskable safe zone).
const files = [
  ['icon-192.png', drawIcon(192, { glyphScale: 0.72, rounded: true })],
  ['icon-512.png', drawIcon(512, { glyphScale: 0.72, rounded: true })],
  // Maskable: platform masks can crop up to ~10% per side — keep the glyph
  // inside the central 80% safe zone and never round the corners ourselves.
  ['icon-512-maskable.png', drawIcon(512, { glyphScale: 0.58, rounded: false })],
  ['apple-touch-icon.png', drawIcon(180, { glyphScale: 0.66, rounded: false })],
];

for (const [name, buf] of files) {
  writeFileSync(resolve(OUT, name), buf);
  console.log(`icons: wrote public/${name} (${buf.length} bytes)`);
}
