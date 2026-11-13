/**
 * 自身消息识别的离线单测（PLAN §13.4 的三个时序）。
 * 跑法：npx tsx tests/unit/own-message.test.ts
 */

import { SentTracker } from '../../src/mtproto/sent-tracker.ts';

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
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

/** 用真实 epoch 量级的时间，避免「0 附近」把时间窗逻辑测成假阳性。 */
const T0 = 1_760_000_000_000;
const CHAT_A = -1001234567890;
const CHAT_B = 123456789;

console.log('\n# 时序①：updateMessageID 先到');
{
  const t = new SentTracker();
  t.registerSend(111n, CHAT_A, T0);
  eq('认领成功', t.onMessageId(111n, 42), null); // 队列里还没有这条消息
  eq('按 id 判定为我方', t.classify({ chatId: CHAT_A, messageId: 42, out: true }, T0 + 50).verdict, 'ours');
}

console.log('\n# 时序②：updateNewMessage 先到 → 隔离 → 被认领');
{
  const t = new SentTracker();
  t.registerSend(222n, CHAT_A, T0);
  const v = t.classify({ chatId: CHAT_A, messageId: 43, out: true }, T0 + 30);
  eq('先压住不判', v.verdict, 'hold');
  eq('认领返回命中的 id', t.onMessageId(222n, 43), 43);
  eq('认领后我方的最终判定', t.resolve(v.token as number, T0 + 60), 'ours');
  ok('隔离队列已清空', t.stats().held === 0);
}

console.log('\n# 时序③：两条更新都丢了 → 时间窗兜底');
{
  const t = new SentTracker();
  t.registerSend(333n, CHAT_A, T0);
  const v = t.classify({ chatId: CHAT_A, messageId: 44, out: true }, T0 + 20);
  eq('先压住', v.verdict, 'hold');
  eq('2 秒后按时间窗判我方', t.resolve(v.token as number, T0 + 2500), 'ours');
}
{
  const t = new SentTracker();
  t.registerSend(444n, CHAT_A, T0);
  const v = t.classify({ chatId: CHAT_A, messageId: 45, out: true }, T0 + 20);
  eq('窗口外（65 秒后）判为 Desktop 发的', t.resolve(v.token as number, T0 + 65_000), 'self');
}

console.log('\n# 其它分支');
{
  const t = new SentTracker();
  eq('out 且无任何发送记录 → Desktop', t.classify({ chatId: CHAT_B, messageId: 1, out: true }, T0).verdict, 'self');
  eq('非 out → 别人发的', t.classify({ chatId: CHAT_B, messageId: 2, out: false }, T0).verdict, 'incoming');
}
{
  // 跨会话不互相污染：给 A 发消息，不应让 B 的 out 消息被压住
  const t = new SentTracker();
  t.registerSend(555n, CHAT_A, T0);
  eq('B 会话不受 A 的发送影响', t.classify({ chatId: CHAT_B, messageId: 3, out: true }, T0 + 10).verdict, 'self');
  eq('A 会话仍然压住', t.classify({ chatId: CHAT_A, messageId: 4, out: true }, T0 + 10).verdict, 'hold');
}
{
  // 同一条消息重复到达（重连补投）
  const t = new SentTracker();
  t.registerSend(666n, CHAT_A, T0);
  t.onMessageId(666n, 77);
  eq('第一次', t.classify({ chatId: CHAT_A, messageId: 77, out: true }, T0 + 10).verdict, 'ours');
  eq('第二次仍是 ours（不会变成 self）', t.classify({ chatId: CHAT_A, messageId: 77, out: true }, T0 + 20).verdict, 'ours');
}

console.log('\n# 清理与泄漏');
{
  const t = new SentTracker();
  t.registerSend(777n, CHAT_A, T0);
  eq('预登记在', t.stats().pending, 1);
  t.sweep(T0 + 130_000);
  eq('120 秒后预登记被清', t.stats().pending, 0);
  ok('隔离队列为空', t.stats().held === 0);
}
{
  const t = new SentTracker();
  for (let i = 0; i < 500; i += 1) t.registerSend(BigInt(i), CHAT_A, T0);
  t.reset();
  eq('reset 清空预登记', t.stats().pending, 0);
  eq('reset 清空已发 id', t.stats().sentIds, 0);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
