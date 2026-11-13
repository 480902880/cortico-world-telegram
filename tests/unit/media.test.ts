/**
 * 媒体相关纯函数单测（文件名、体积、扩展名）。
 * 跑法：npx tsx tests/unit/media.test.ts
 */

import { extForMime, humanBytes, mediaFileName } from '../../src/mtproto/client.ts';

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

console.log('\n# 扩展名');
eq('jpeg → jpg', extForMime('image/jpeg'), 'jpg');
eq('png', extForMime('image/png'), 'png');
eq('ogg', extForMime('audio/ogg'), 'ogg');
eq('opus', extForMime('audio/opus'), 'opus');
eq('mp4', extForMime('video/mp4'), 'mp4');
eq('未知 → 空', extForMime('application/x-weird'), '');

console.log('\n# 落盘文件名');
eq('图片', mediaFileName({ kind: 'photo', mime: 'image/jpeg' }, 42), 'tg-42-photo.jpg');
eq('语音', mediaFileName({ kind: 'voice', mime: 'audio/ogg' }, 7), 'tg-7-voice.ogg');
eq('无 mime 时不加扩展名', mediaFileName({ kind: 'document' }, 9), 'tg-9-document');
eq('不含斜杠等危险字符', /[/\\:*?"<>|]/.test(mediaFileName({ kind: 'other', mime: 'application/zip' }, 1)), false);

console.log('\n# 体积');
eq('0', humanBytes(0), '0 B');
eq('999B', humanBytes(999), '999 B');
eq('1KB', humanBytes(1024), '1 KB');
eq('1.5MB', humanBytes(1.5 * 1024 * 1024), '1.5 MB');
eq('10MB 取整', humanBytes(10 * 1024 * 1024), '10 MB');

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
