/**
 * 合并窗口的纯逻辑单测。
 * 跑法：npx tsx tests/unit/merge.test.ts
 */

import {
  composeMergedMeta,
  composeMergedText,
  shouldBuffer,
  shouldFlush,
} from '../../src/inbound/merge.ts';

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

console.log('\n# 要不要进缓冲');
{
  ok('窗口 3000 → 缓冲', shouldBuffer({ windowMs: 3000, maxAgeMs: 8000, maxItems: 10 }));
  ok('窗口 0 → 不缓冲', !shouldBuffer({ windowMs: 0, maxAgeMs: 8000, maxItems: 10 }));
  ok('只允许 1 条 → 不缓冲', !shouldBuffer({ windowMs: 3000, maxAgeMs: 8000, maxItems: 1 }));
}

console.log('\n# 何时立刻 flush');
{
  const policy = { windowMs: 3000, maxAgeMs: 8000, maxItems: 3 };
  const t0 = 1_760_000_000_000;
  ok('攒满 3 条', shouldFlush(3, t0, t0 + 100, policy));
  ok('1 条不 flush', !shouldFlush(1, t0, t0 + 100, policy));
  ok('超过 maxAge（8s）即便只有 1 条也 flush', shouldFlush(1, t0, t0 + 8000, policy));
  ok('空缓冲不 flush', !shouldFlush(0, t0, t0 + 99_999, policy));
  const noItemLimit = { windowMs: 3000, maxAgeMs: 0, maxItems: 0 };
  ok('maxItems=0 时不受条数限制', !shouldFlush(50, t0, t0 + 100, noItemLimit));
  ok('maxAge=0 时不受时长限制', !shouldFlush(1, t0, t0 + 999_999, noItemLimit));
}

console.log('\n# 合并正文');
{
  eq('一行一条', composeMergedText(['A: 在吗', 'A: 那个 bug']), 'A: 在吗\nA: 那个 bug');
  eq('丢掉空行', composeMergedText(['A: x', '', 'A: y']), 'A: x\nA: y');
  eq('空数组', composeMergedText([]), '');
}

console.log('\n# 合并 meta');
{
  const base = { chat_id: -100, message_id: 55, chat_kind: 'group' };
  eq('单条不动', composeMergedMeta(base, [55], 1), base);
  const merged = composeMergedMeta(base, [50, 51, 55], 3);
  eq('带上数量', merged.merged, 3);
  eq('带上 id 列表', merged.message_ids, [50, 51, 55]);
  eq('首条', merged.first_message_id, 50);
  eq('末条', merged.last_message_id, 55);
  eq('保留原字段', merged.chat_id, -100);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
