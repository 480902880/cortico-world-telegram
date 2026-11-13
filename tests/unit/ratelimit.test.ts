/**
 * P7 稳定性：限流、FloodWait 解析、断线补课筛选。
 * 全离线：不联网、不需要账号。
 * 跑法：npx tsx tests/unit/ratelimit.test.ts
 */

import { GAP_CHECK_INTERVAL_MS, selectFreshMessages, shouldRunGapCheck } from '../../src/inbound/catchup.ts';
import { FLOOD_RETRY_MAX_SECONDS, RateLimiter, floodWaitSeconds } from '../../src/mtproto/ratelimit.ts';
import type { Msg } from '../../src/mtproto/port.ts';

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
    console.log(`  FAIL ${name} — 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
  }
}

console.log('\n# FloodWait 解析');
eq('普通', floodWaitSeconds('FLOOD_WAIT_42'), 42);
eq('小写也认', floodWaitSeconds('flood_wait_7'), 7);
eq('零秒', floodWaitSeconds('FLOOD_WAIT_0'), 0);
eq('不是限流', floodWaitSeconds('PEER_FLOOD'), null);
eq('空串', floodWaitSeconds(''), null);
eq('超阈值（60s）不自动等', 120 > FLOOD_RETRY_MAX_SECONDS, true);

console.log('\n# 每会话限流');
{
  let clock = 1_000_000;
  const slept: number[] = [];
  const limiter = new RateLimiter({
    perChatMs: 1000,
    globalPerMinute: 100,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  const start = clock;
  await limiter.acquire(1);
  eq('第一条不等', slept.length, 0);
  eq('记录了发送时刻', limiter.waitFor(1), 1000);

  await limiter.acquire(1);
  eq('同会话第二条等 1000ms', slept, [1000]);
  eq('总耗时', clock - start, 1000);

  await limiter.acquire(2);
  eq('不同会话不互相等', slept, [1000]);
}

console.log('\n# 全局每分钟上限');
{
  let clock = 2_000_000;
  const slept: number[] = [];
  const limiter = new RateLimiter({
    perChatMs: 0,
    globalPerMinute: 3,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  for (let i = 0; i < 3; i += 1) await limiter.acquire(i);
  eq('前三条不等', slept.length, 0);
  await limiter.acquire(99);
  eq('第四条被全局上限拦下', slept.length, 1);
  ok('等的时间接近一分钟', (slept[0] ?? 0) >= 59_000, String(slept[0]));
  eq('窗口滑过之后清零', (() => {
    clock += 61_000;
    return limiter.waitFor(99);
  })(), 0);
}

console.log('\n# 断线补课筛选');
{
  const now = 1_760_000_000_000;
  const msg = (id: number, ageMinutes: number): Msg => ({
    chatId: 1,
    chatKind: 'user',
    id,
    date: Math.floor((now - ageMinutes * 60_000) / 1000),
    text: `m${id}`,
    out: false,
  });

  const messages = [msg(5, 1), msg(3, 10), msg(4, 5), msg(1, 30 * 60)];

  eq('只补 lastSeen 之后的', selectFreshMessages(messages, { lastSeenId: 3, now }).map((m) => m.id), [4, 5]);
  eq('按 id 升序', selectFreshMessages(messages, { lastSeenId: 0, now }).map((m) => m.id), [3, 4, 5]);
  eq('超过 24h 的不补', selectFreshMessages(messages, { lastSeenId: 0, now }).some((m) => m.id === 1), false);
  eq('没有 lastSeen 时从最早的开始', selectFreshMessages(messages, { now }).map((m) => m.id), [3, 4, 5]);
  eq('limit 生效', selectFreshMessages(messages, { now, limit: 2 }).map((m) => m.id), [3, 4]);
  eq('空列表', selectFreshMessages([], { now }), []);
  eq('自定义时间窗（只看 2 分钟内）', selectFreshMessages(messages, { now, maxAgeMs: 2 * 60_000 }).map((m) => m.id), [5]);
}

console.log('\n# 运行中补课的节流');
{
  const now = 1_760_000_000_000;
  ok('从没跑过 → 该跑', shouldRunGapCheck(0, now));
  ok('刚跑过 → 不跑', !shouldRunGapCheck(now - 60_000, now));
  ok('差 9 分钟 → 不跑', !shouldRunGapCheck(now - 9 * 60_000, now));
  ok('差 10 分钟 → 跑', shouldRunGapCheck(now - 10 * 60_000, now));
  ok('时间倒退（负数）→ 该跑', shouldRunGapCheck(-5, now));
  ok('间隔是 10 分钟', GAP_CHECK_INTERVAL_MS === 600_000);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
