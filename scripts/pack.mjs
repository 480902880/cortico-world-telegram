/**
 * 打市场包：只装 src / dist / types / 清单与说明，不含 node_modules、tests、docs。
 *
 * 跑法：npm run pack:release
 * 产物：release/<name>-<version>.zip
 *
 * 为什么必须带上 dist/webui.js：
 *   面板 bundle 是包内资产（`cortico.webUiClient`），缺了它 WebUI 渲染不出来，
 *   连「一键安装依赖」的卡片都看不到——新用户会永远卡在第一步。
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { checkDescribeFreshness, checkWebuiFreshness } from './freshness.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// P-01：先确认产物不是旧的——宁可打包失败，也别打出一个「面板看着正常、其实是旧代码」的死包
const webui = checkWebuiFreshness(root);
if (!webui.ok) {
  throw new Error(`打包中止：${webui.reason}。先跑 npm run build:webui`);
}
const desc = checkDescribeFreshness(root);
if (!desc.ok) {
  throw new Error(`打包中止：${desc.reason}。先跑 npm run describe`);
}
console.log(`产物校验通过（webui sourceHash ${webui.meta.sourceHash}）`);

// `--check`：只校验产物新鲜度，不生成 zip（给 npm run verify 用）
if (process.argv.includes('--check')) {
  console.log('只做校验，未生成压缩包（--check）');
  process.exit(0);
}

/** 进包的顶层条目。 */
const INCLUDE = [
  'src',
  'dist',
  'types',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'LICENSE',
  'describe.json',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const files = [];
for (const item of INCLUDE) {
  const full = join(root, item);
  if (!existsSync(full)) {
    console.warn(`跳过缺失条目：${item}`);
    continue;
  }
  if (statSync(full).isDirectory()) files.push(...walk(full));
  else files.push(full);
}

const relatives = new Set(files.map((file) => relative(root, file).replace(/\\/g, '/')));
for (const need of ['dist/webui.js', 'describe.json', 'package.json', 'src/index.ts', 'LICENSE']) {
  if (!relatives.has(need)) {
    throw new Error(`打包失败：缺少必需文件 ${need}（先跑 npm run build:webui / npm run describe）`);
  }
}

/** CRC32（zip 必需）。 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** zip 时间戳。 */
function dosTime(date) {
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
    day: (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  };
}

// 产物默认放在仓库**外面**（D:\Ai），别把压缩包混进在用的插件目录
const outDir = process.env.RELEASE_DIR?.trim() || dirname(root);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${pkg.name}-${pkg.version}.zip`);
const { time, day } = dosTime(new Date());

const localParts = [];
const centralParts = [];
let offset = 0;
let count = 0;

for (const file of files) {
  const name = relative(root, file).replace(/\\/g, '/');
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = readFileSync(file);
  const compressed = raw.length > 64 ? deflateRawSync(raw, { level: 9 }) : raw;
  const deflated = compressed.length < raw.length;
  const body = deflated ? compressed : raw;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(deflated ? 8 : 0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, nameBuf, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(deflated ? 8 : 0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, nameBuf);

  offset += local.length + nameBuf.length + body.length;
  count += 1;
}

const centralBuf = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(count, 8);
end.writeUInt16LE(count, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

await new Promise((resolve, reject) => {
  const stream = createWriteStream(outFile);
  stream.on('error', reject);
  stream.on('finish', resolve);
  stream.write(Buffer.concat(localParts));
  stream.write(centralBuf);
  stream.end(end);
});

const size = statSync(outFile).size;
console.log(`已生成 ${outFile}`);
console.log(`  条目 ${count} 个 · ${(size / 1024).toFixed(0)} KB`);
console.log('  含 dist/webui.js（面板）、describe.json（自描述）、LICENSE、src 源码');
