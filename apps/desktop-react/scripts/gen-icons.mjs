#!/usr/bin/env node
// 임시 앱 아이콘 생성 (외부 의존성 없음). 정식 아이콘이 나오면 `pnpm tauri icon <원본.png>` 로 교체한다.
// 출력: src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.png,icon.ico}

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 브라운 둥근 사각형 + 흰색 B */
function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.18;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const inB = (x, y) => {
    const u = x / size;
    const v = y / size;
    const stem = u >= 0.3 && u <= 0.42 && v >= 0.2 && v <= 0.8;
    const bars = u >= 0.3 && u <= 0.66 && ((v >= 0.2 && v <= 0.31) || (v >= 0.465 && v <= 0.575) || (v >= 0.69 && v <= 0.8));
    const bumps = u >= 0.6 && u <= 0.72 && ((v >= 0.27 && v <= 0.5) || (v >= 0.52 && v <= 0.74));
    return stem || bars || bumps;
  };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      if (!inRounded(px, py)) continue; // 투명
      const [cr, cg, cb] = inB(px, py) ? [255, 255, 255] : [138, 96, 73];
      raw[o] = cr;
      raw[o + 1] = cg;
      raw[o + 2] = cb;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG 를 담은 ICO (Vista+ 지원) */
function ico(sizes) {
  const images = sizes.map((s) => ({ s, data: png(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ s, data }) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

writeFileSync(join(outDir, '32x32.png'), png(32));
writeFileSync(join(outDir, '128x128.png'), png(128));
writeFileSync(join(outDir, '128x128@2x.png'), png(256));
writeFileSync(join(outDir, 'icon.png'), png(512));
writeFileSync(join(outDir, 'icon.ico'), ico([16, 24, 32, 48, 64, 256]));
console.log(`아이콘 생성: ${outDir}`);
