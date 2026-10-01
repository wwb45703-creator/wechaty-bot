/**
 * 生成 build/icon.ico —— 256x256 粉白渐变圆角方块
 *
 * 纯 Node 实现（只用内置 zlib，无任何依赖）：
 *  1. 逐像素绘制带抗锯齿圆角的粉白渐变方块（RGBA 原始数据）
 *  2. 手工拼装 PNG（IHDR / IDAT / IEND，自实现 CRC32，zlib.deflateSync 压缩）
 *  3. 按 ICO 规范打包：6 字节 ICONDIR 头 + 16 字节 ICONDIRENTRY + PNG 数据
 *     （Windows Vista+ 支持 PNG-in-ICO，单条 256x256 条目即可）
 *
 * 运行：node scripts/make-icon.js
 * 输出：<ui>/build/icon.ico
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ==================== 参数 ====================
const SIZE = 256;      // 图标边长（像素）
const RADIUS = 56;     // 圆角半径（像素）
// 渐变端点：左上近白粉 → 右下粉（对角线方向渐变）
const COLOR_FROM = [255, 245, 249]; // #FFF5F9 近白粉
const COLOR_TO = [255, 136, 180];   // #FF88B4 粉色

// ==================== 圆角抗锯齿 ====================
/**
 * 计算像素中心到圆角矩形的覆盖度（0~1）。
 * 思路：把像素中心向内"钳"到内接矩形，再算它到圆角圆心的距离；
 * 距离小于 RADIUS 即在图形内，边缘 1 像素线性过渡实现抗锯齿。
 */
function roundedAlpha(px, py) {
  const cx = Math.min(Math.max(px + 0.5, RADIUS), SIZE - RADIUS);
  const cy = Math.min(Math.max(py + 0.5, RADIUS), SIZE - RADIUS);
  const dx = px + 0.5 - cx;
  const dy = py + 0.5 - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, Math.min(1, RADIUS - dist + 0.5));
}

// ==================== 绘制 RGBA 原始数据 ====================
// PNG 每行前有 1 字节 filter 类型（0 = None），所以行宽 = 1 + SIZE*4
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    // 对角线渐变系数 t: 0(左上) → 1(右下)
    const t = (x + y) / (2 * (SIZE - 1));
    const r = Math.round(COLOR_FROM[0] + (COLOR_TO[0] - COLOR_FROM[0]) * t);
    const g = Math.round(COLOR_FROM[1] + (COLOR_TO[1] - COLOR_FROM[1]) * t);
    const b = Math.round(COLOR_FROM[2] + (COLOR_TO[2] - COLOR_FROM[2]) * t);
    const a = Math.round(roundedAlpha(x, y) * 255);
    const o = rowStart + 1 + x * 4;
    raw[o] = r;
    raw[o + 1] = g;
    raw[o + 2] = b;
    raw[o + 3] = a;
  }
}

// ==================== PNG 组装 ====================

// CRC32 查表法（PNG chunk 校验用）
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 拼一个 PNG chunk：长度(4) + 类型(4) + 数据 + CRC32(4) */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// IHDR：宽、高、位深 8、颜色类型 6(RGBA)、压缩 0、滤波 0、隔行 0
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.writeUInt8(8, 8);
ihdr.writeUInt8(6, 9);
ihdr.writeUInt8(0, 10);
ihdr.writeUInt8(0, 11);
ihdr.writeUInt8(0, 12);

const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 签名
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', idat),
  pngChunk('IEND', Buffer.alloc(0)),
]);

// ==================== ICO 打包 ====================
// ICONDIR（6 字节）：保留 0、类型 1(图标)、条目数 1
const icondir = Buffer.alloc(6);
icondir.writeUInt16LE(0, 0);
icondir.writeUInt16LE(1, 2);
icondir.writeUInt16LE(1, 4);

// ICONDIRENTRY（16 字节）：宽/高写 0 表示 256；PNG 条目 bitCount 32
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);              // 宽：0 = 256
entry.writeUInt8(0, 1);              // 高：0 = 256
entry.writeUInt8(0, 2);              // 调色板色数（PNG 条目填 0）
entry.writeUInt8(0, 3);              // 保留
entry.writeUInt16LE(1, 4);           // 颜色平面数
entry.writeUInt16LE(32, 6);          // 位深
entry.writeUInt32LE(png.length, 8);  // 图像数据字节数
entry.writeUInt32LE(22, 12);         // 数据偏移：6 + 16 = 22

const ico = Buffer.concat([icondir, entry, png]);

// ==================== 写出 ====================
const outFile = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, ico);

// 简单自检：确认写出的文件 ICO 头 + 内嵌 PNG 签名都正确
const check = fs.readFileSync(outFile);
const okIco = check.length > 22 && check.readUInt16LE(2) === 1 && check.readUInt16LE(4) === 1;
const okPng =
  check[22] === 0x89 && check[23] === 0x50 && check[24] === 0x4e && check[25] === 0x47;
if (!okIco || !okPng) {
  console.error('[make-icon] 自检失败：生成的文件结构不正确');
  process.exit(1);
}
console.log('[make-icon] 已生成 ' + outFile + '（' + ico.length + ' 字节，256x256 PNG-in-ICO）');
