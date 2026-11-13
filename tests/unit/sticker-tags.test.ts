/**
 * 本地表情标签存储的单测（真写临时目录）。
 * 跑法：npx tsx tests/unit/sticker-tags.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StickerTagStore, describeTag } from '../../src/stickers/tags.ts';

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
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} — 实际 ${JSON.stringify(actual)}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'tg-tags-'));

try {
  console.log('\n# 空库');
  {
    const store = new StickerTagStore(dir);
    eq('刚开始是空的', store.all(), {});
    const files = [{ name: 'a.jpg', size: 10 }, { name: 'b.gif', size: 20 }];
    eq('两个都待标', store.pending(files).map((f) => f.name), ['a.jpg', 'b.gif']);
    eq('统计', store.summary(files), { total: 2, tagged: 0, pending: 2 });
  }

  console.log('\n# 写入与统计');
  {
    const store = new StickerTagStore(dir);
    const saved = store.save([
      { name: 'a.jpg', tags: ['无语', ' 翻白眼 ', ''], usage: '用户说无聊时', size: 10 },
      { name: 'b.gif', tags: ['开心'], usage: '', size: 20 },
    ]);
    eq('写入 2 条', saved, 2);
    eq('标签去空白', store.get('a.jpg')?.tags, ['无语', '翻白眼']);
    eq('usage 保留', store.get('a.jpg')?.usage, '用户说无聊时');

    const files = [{ name: 'a.jpg', size: 10 }, { name: 'b.gif', size: 20 }];
    eq('都标完了', store.pending(files), []);
    eq('统计', store.summary(files), { total: 2, tagged: 2, pending: 0 });
  }

  console.log('\n# 文件被替换（大小变了）→ 重新待标');
  {
    const store = new StickerTagStore(dir);
    const changed = [{ name: 'a.jpg', size: 99 }, { name: 'b.gif', size: 20 }];
    eq('大小变了算待标', store.pending(changed).map((f) => f.name), ['a.jpg']);
    eq('统计', store.summary(changed), { total: 2, tagged: 1, pending: 1 });
  }

  console.log('\n# 落盘与重载');
  {
    const first = new StickerTagStore(dir);
    first.save([{ name: 'c.png', tags: ['猫猫'], usage: '卖萌', size: 5 }]);
    const second = new StickerTagStore(dir);
    eq('新实例能读到', second.get('c.png')?.tags, ['猫猫']);
  }

  console.log('\n# 无效输入');
  {
    const store = new StickerTagStore(dir);
    eq('空名字跳过', store.save([{ name: '  ', tags: ['x'], usage: 'y', size: 1 }]), 0);
    eq('没标签也没场景跳过', store.save([{ name: 'd.png', tags: [], usage: '  ', size: 1 }]), 0);
    eq('标签最多 12 个', store.save([{ name: 'e.png', tags: Array.from({ length: 20 }, (_, i) => `t${i}`), usage: 'x', size: 1 }]) === 1
      ? store.get('e.png')?.tags.length : -1, 12);
  }

  console.log('\n# 描述');
  {
    eq('有标签', describeTag('a.jpg', store0()), 'a.jpg【无语、翻白眼】 — 用户说无聊时');
    eq('没标签', describeTag('zz.jpg', undefined), 'zz.jpg（未标注）');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function store0() {
  const store = new StickerTagStore(dir);
  store.save([{ name: 'a.jpg', tags: ['无语', '翻白眼'], usage: '用户说无聊时', size: 10 }]);
  return store.get('a.jpg');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
