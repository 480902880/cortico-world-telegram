/**
 * 通知闸门的单测。
 * 跑法：npx tsx tests/unit/owner-trust.test.ts
 *
 * 身份判定不在扩展里（口令归 Coo），这里只测"转告主人"的限速与去重。
 */

import { NotifyGate } from '../../src/owner.ts';

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

console.log('\n# 转告闸门');
{
  const gate = new NotifyGate(3, 10 * 60_000);
  const t0 = 4_000_000;
  ok('第一条放行', gate.allow('a', t0).ok);
  ok('同样内容 10 分钟内去重', !gate.allow('a', t0 + 1_000).ok);
  ok('内容不同放行', gate.allow('b', t0 + 2_000).ok);
  ok('第三条放行', gate.allow('c', t0 + 3_000).ok);
  ok('超过每小时上限拒绝', !gate.allow('d', t0 + 4_000).ok);
  ok('窗口滑过后恢复', gate.allow('d', t0 + 3_601_000).ok);
  ok('空内容拒绝', !gate.allow('   ', t0).ok);
  ok('默认每小时 10 条', (() => {
    const g = new NotifyGate();
    for (let i = 0; i < 10; i += 1) g.allow(`m${i}`, t0 + i);
    return !g.allow('m11', t0 + 20).ok;
  })());
  ok('大小写/空白归一后算重复', (() => {
    const g = new NotifyGate();
    g.allow('Hello  World', t0);
    return !g.allow('hello world', t0 + 1_000).ok;
  })());
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;