/**
 * 图片字节探测的单测（Telegram photo 消息不带 MIME，只能靠魔术字节）。
 * 跑法：npx tsx tests/unit/image.test.ts
 */

import { isViewableImage, sniffImageMime } from '../../src/media/image.ts';

let passed = 0;
let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} — 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
  }
}

function head(...bytes: number[]): Uint8Array {
  const buffer = new Uint8Array(Math.max(16, bytes.length));
  buffer.set(bytes);
  return buffer;
}

console.log('\n# 魔术字节');
eq('PNG', sniffImageMime(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
eq('JPEG', sniffImageMime(head(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
eq('GIF', sniffImageMime(head(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'image/gif');
eq(
  'WEBP',
  sniffImageMime(head(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50)),
  'image/webp',
);
eq('MP4 不是图片', sniffImageMime(head(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70)), null);
eq('太短', sniffImageMime(new Uint8Array([0x89, 0x50])), null);
eq('空', sniffImageMime(new Uint8Array()), null);

console.log('\n# 能否视图');
eq('png 可以', isViewableImage('image/png'), true);
eq('jpeg 可以', isViewableImage('image/jpeg'), true);
eq('webp 可以', isViewableImage('image/webp'), true);
eq('tgs 不行', isViewableImage('application/x-tgsticker'), false);
eq('视频不行', isViewableImage('video/webm'), false);
eq('空值不行', isViewableImage(undefined), false);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
