/**
 * 表情包相关纯函数单测：Document → StickerInfo、按序号/emoji 挑一个。
 * 跑法：npx tsx tests/unit/sticker.test.ts
 */

import { normalizeStickerShortName, pickSticker, toStickerInfo } from '../../src/mtproto/client.ts';
import { isLocalStickerUsable, isStickerFile, localStickerForm, stickerMime } from '../../src/resources.ts';
import type { StickerInfo } from '../../src/mtproto/port.ts';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
    === JSON.stringify(expected, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  if (same) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} — 实际 ${JSON.stringify(actual, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`);
  }
}

console.log('\n# Document → StickerInfo');
{
  // 模拟 big-integer 对象（toString 可用），验证转 native bigint
  const doc = {
    id: { toString: () => '5380000000000001' },
    accessHash: { toString: () => '-7766392811203979806' },
    fileReference: new Uint8Array([1, 2, 3]),
    mimeType: 'application/x-tgsticker',
  };
  const info = toStickerInfo(doc, '😹');
  ok('有结果', !!info);
  eq('id 转成 bigint', String(info!.id), '5380000000000001');
  eq('accessHash 保留符号', String(info!.accessHash), '-7766392811203979806');
  eq('emoji 带上', info!.emoji, '😹');
  eq('mime 带上', info!.mime, 'application/x-tgsticker');
  eq('fileReference 长度', info!.fileReference.length, 3);
}
{
  eq('没有 id 返回 null', toStickerInfo({}), null);
  const noEmoji = toStickerInfo({ id: 1, accessHash: 2, mimeType: 'image/webp' });
  ok('没有 emoji 时字段不出现', noEmoji !== null && noEmoji.emoji === undefined);
}

console.log('\n# 挑贴纸');
{
  const sticker = (id: number, emoji?: string): StickerInfo => ({
    id: BigInt(id),
    accessHash: 0n,
    fileReference: new Uint8Array(),
    ...(emoji ? { emoji } : {}),
    mime: 'image/webp',
  });
  const pack = [sticker(10, '😀'), sticker(11, '😹'), sticker(12, '😹'), sticker(13)];

  eq('按序号 0', pickSticker(pack, { index: 0 })?.sticker.id, 10n);
  eq('按序号 2', pickSticker(pack, { index: 2 })?.sticker.id, 12n);
  eq('默认第 0 个', pickSticker(pack)?.sticker.id, 10n);
  eq('按 emoji 取第一个匹配', pickSticker(pack, { emoji: '😹' })?.sticker.id, 11n);

  const overflow = pickSticker(pack, { index: 99 });
  eq('越界退回第一个', overflow?.sticker.id, 10n);
  ok('越界有说明', !!overflow?.note && overflow.note.includes('超出范围'), overflow?.note);

  const noMatch = pickSticker(pack, { emoji: '🐱' });
  eq('emoji 没匹配时退回序号', noMatch?.sticker.id, 10n);
  ok('没匹配不撒谎（无 note 或提示，但不报错）', noMatch !== null);

  eq('空包返回 null', pickSticker([], { index: 0 }), null);
}

console.log('\n# 短名规整');
{
  eq('正常短名', normalizeStickerShortName('HotCherry'), { ok: true, shortName: 'HotCherry' });
  eq('去 @ 前缀', normalizeStickerShortName('@Cats'), { ok: true, shortName: 'Cats' });
  eq('从链接里抽', normalizeStickerShortName('https://t.me/addstickers/HotCherry'), { ok: true, shortName: 'HotCherry' });
  eq('前后空格', normalizeStickerShortName('  Cats  '), { ok: true, shortName: 'Cats' });
  ok('中文被拒', normalizeStickerShortName('丰川祥子').ok === false);
  ok('中文错误里有指引', String((normalizeStickerShortName('丰川祥子') as { reason?: string }).reason).includes('addstickers'));
  ok('带空格标题被拒', normalizeStickerShortName('Hot Cherry').ok === false);
  ok('空串被拒', normalizeStickerShortName('').ok === false);
}

console.log('\n# 本地表情文件');
{
  eq('png 算表情（静态）', isStickerFile('a.png'), true);
  eq('webp 算表情', isStickerFile('a.webp'), true);
  eq('tgs 算表情', isStickerFile('a.tgs'), true);
  eq('webm 算表情', isStickerFile('a.webm'), true);
  eq('jpg 不算', isStickerFile('a.jpg'), false);

  eq('webp → image/webp', stickerMime('a.WEBP'), 'image/webp');
  eq('tgs → x-tgsticker', stickerMime('a.tgs'), 'application/x-tgsticker');
  eq('webm → video/webm', stickerMime('a.webm'), 'video/webm');
  eq('png → image/png', stickerMime('a.png'), 'image/png');
}

console.log('\n# 发出去的形态（格式分流）');
{
  eq('png → 表情', localStickerForm('a.png'), 'sticker');
  eq('tgs → 表情', localStickerForm('a.tgs'), 'sticker');
  eq('gif → 动图', localStickerForm('a.gif'), 'gif');
  eq('jpg → 图片', localStickerForm('a.jpg'), 'photo');
  eq('大写 JPEG 也认', localStickerForm('a.JPEG'), 'photo');
  eq('mp4 用不了', localStickerForm('a.mp4'), null);
  ok('jpg 可用（当图片发）', isLocalStickerUsable('a.jpg'));
  ok('gif 可用（当动图发）', isLocalStickerUsable('a.gif'));
  ok('mp4 不可用', !isLocalStickerUsable('a.mp4'));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
