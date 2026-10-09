'use strict';

/**
 * تولید آیکون‌های ساده‌ی PNG برای اکستنشن.
 * نیازی به وابستگی خارجی نداره — PNG رو دستی می‌سازه.
 *
 *   node tools/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'extension', 'icons');

// ------- helpers PNG -------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makePng(size) {
  const w = size;
  const h = size;

  // RGBA pixels
  const px = Buffer.alloc(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  const rOuter = Math.min(w, h) / 2 - 1;
  const rInner = rOuter * 0.55;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // پس‌زمینه: گرادیان دایره‌ای آبی تیره
      let r = 11, g = 16, b = 32, a = 255;

      if (dist <= rOuter) {
        const t = Math.min(1, dist / rOuter);
        r = Math.round(11 + (14 - 11) * t);
        g = Math.round(16 + (58 - 16) * t);
        b = Math.round(32 + (138 - 32) * t);
      } else {
        // بیرون: شفاف (آیکون دایره‌ای)
        a = 0;
      }

      // نماد پل: دو قوس + خط افقی
      const bridgeY = cy + rOuter * 0.18;
      const onDeck = Math.abs(y - bridgeY) <= Math.max(1, h * 0.045);
      const inSpan = Math.abs(x - cx) <= rOuter * 0.72;

      // پایه‌های پل (دو ستون عمودی)
      const colW = Math.max(1.5, w * 0.055);
      const leftCol = Math.abs(x - (cx - rOuter * 0.55)) <= colW && y >= bridgeY - rOuter * 0.42 && y <= bridgeY;
      const rightCol = Math.abs(x - (cx + rOuter * 0.55)) <= colW && y >= bridgeY - rOuter * 0.42 && y <= bridgeY;

      // عرشه‌ی پل
      const deck = onDeck && inSpan;

      // قوس بالای پل
      const archDx = Math.abs(x - cx);
      const archY = bridgeY - Math.sqrt(Math.max(0, (rOuter * 0.55) ** 2 - archDx ** 2)) * 0.62 - rOuter * 0.05;
      const arch = Math.abs(y - archY) <= Math.max(1, h * 0.05) && archDx <= rOuter * 0.52;

      if (deck || leftCol || rightCol || arch) {
        r = 56;
        g = 189;
        b = 248;
      }

      px.writeUInt8(r, idx);
      px.writeUInt8(g, idx + 1);
      px.writeUInt8(b, idx + 2);
      px.writeUInt8(a, idx + 3);
    }
  }

  // فیلتر None برای هر ردیف
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0]));
    rows.push(px.subarray(y * w * 4, (y + 1) * w * 4));
  }
  const raw = Buffer.concat(rows);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const out = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(out, makePng(size));
  console.log('نوشته شد:', out);
}
console.log('✅ آیکون‌ها ساخته شدند');
