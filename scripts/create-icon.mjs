import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Deterministic raster source: the radio's dot matrix forms a C at Dock sizes.
const size = 1024;
const pixels = Buffer.alloc((size * 4 + 1) * size);
const pattern = [
  "001111100", "011111110", "111000011", "110000000", "110000000",
  "110000000", "111000011", "011111110", "001111100",
];
const dots = [];
for (let row = 0; row < 9; row++) for (let col = 0; col < 9; col++) {
  if (pattern[row][col] === "1") dots.push({ x: 256 + col * 64, y: 256 + row * 64, red: false });
}
dots.push({ x: 768, y: 512, red: true });
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  const dx = Math.max(148 - x, 0, x - 875);
  const dy = Math.max(148 - y, 0, y - 875);
  const alpha = Math.max(0, Math.min(1, 149 - Math.hypot(dx, dy)));
  let color = [29, 30, 32];
  for (const dot of dots) {
    const coverage = Math.max(0, Math.min(1, 22.5 - Math.hypot(x - dot.x, y - dot.y)));
    if (coverage > 0) {
      const ink = dot.red ? [239, 84, 73] : [240, 239, 231];
      color = color.map((value, index) => Math.round(value + (ink[index] - value) * coverage));
      break;
    }
  }
  pixels.set([...color, Math.round(alpha * 255)], offset);
}
function crc32(data) {
  let crc = -1;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const directory = resolve("desktop/assets");
mkdirSync(directory, { recursive: true });
const png = resolve(directory, "icon.png");
writeFileSync(png, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
if (process.platform === "darwin") {
  const iconset = resolve(".desktop-build/Claudio.iconset");
  mkdirSync(iconset, { recursive: true });
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) execFileSync("sips", ["-z", String(points * scale), String(points * scale),
      png, "--out", `${iconset}/icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`], { stdio: "ignore" });
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", resolve(directory, "icon.icns")]);
}
console.log(`Icon: ${png}`);
