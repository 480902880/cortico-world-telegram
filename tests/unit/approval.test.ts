/**
 * 审批机制单测：一次性、过期、指令解析。
 * 跑法：npx tsx tests/unit/approval.test.ts
 */

import {
  Approvals,
  classifyOwnerReply,
  makeApprovalCode,
  parseApprovalCommand,
  renderApprovals,
} from '../../src/approval.ts';

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

console.log('\n# 码生成');
{
  const code = makeApprovalCode(() => 0.5);
  eq('长度 4', code.length, 4);
  ok('只含无歧义字符', /^[A-HJ-NP-Z2-9]{4}$/.test(code), code);
  const codes = new Set(Array.from({ length: 200 }, () => makeApprovalCode()));
  ok('随机性还行（200 次不全是同一个）', codes.size > 100, String(codes.size));
}

console.log('\n# 一次性');
{
  let now = 1_000_000;
  let ran = 0;
  const approvals = new Approvals({ ttlMs: 60_000, now: () => now });
  const req = approvals.request('delete', '删除 3 条消息', '123456789', async () => {
    ran += 1;
    return '[deleted 3]';
  });
  eq('登记后 size=1', approvals.size(), 1);
  const first = approvals.take(req.code);
  ok('第一次取到', first?.code === req.code);
  eq('再取同一码为 null（用完即焚）', approvals.take(req.code), null);
  ok('run 还没被执行', ran === 0);
  await first!.run();
  eq('批准后才执行', ran, 1);
}

console.log('\n# 过期');
{
  let now = 1_000_000;
  const approvals = new Approvals({ ttlMs: 1000, now: () => now });
  const req = approvals.request('delete', 'x', '1', async () => 'ok');
  now += 1001;
  eq('过期后 take 为 null', approvals.take(req.code), null);
  eq('过期项被清掉', approvals.size(), 0);
}
{
  let now = 1_000_000;
  const approvals = new Approvals({ ttlMs: 1000, now: () => now });
  const req = approvals.request('delete', 'x', '1', async () => 'ok');
  now += 500;
  ok('未过期时 peek 可用', approvals.peek(req.code) !== null);
  now += 600;
  eq('peek 过期后为 null', approvals.peek(req.code), null);
}

console.log('\n# 取消');
{
  const approvals = new Approvals();
  const req = approvals.request('forward', 'y', '1', async () => 'ok');
  ok('取消成功', approvals.cancel(req.code));
  eq('取消后取不到', approvals.take(req.code), null);
}

console.log('\n# 指令解析');
{
  eq('!ok 带码', parseApprovalCommand('!ok A7F3'), { decision: 'ok', code: 'A7F3' });
  eq('小写码会转大写', parseApprovalCommand('!no ab12'), { decision: 'no', code: 'AB12' });
  eq('!list', parseApprovalCommand('!list'), { decision: 'list' });
  eq('!ok 不带码', parseApprovalCommand('!ok'), { decision: 'ok' });
  eq('普通聊天返回 null', parseApprovalCommand('好的，批准'), null);
  eq('空串返回 null', parseApprovalCommand(''), null);
  eq('带前缀文本不算', parseApprovalCommand('我觉得 !ok A7F3 可以'), null);
}

console.log('\n# 清单渲染');
{
  eq('空清单', renderApprovals([]), '没有待批准的操作。');
  const approvals = new Approvals();
  approvals.request('delete', '删除 3 条消息', '1', async () => 'ok');
  const text = renderApprovals(approvals.list());
  ok('含码与摘要', text.includes('删除 3 条消息') && /[A-Z0-9]{4}/.test(text), text);
  ok('提示怎么回复', text.includes('!ok'), text);
}

console.log('\n# 主人用大白话回复');
{
  for (const text of ['可以', '行', '好', '发吧', '没问题', 'OK', '行吧，发']) {
    eq(`「${text}」→ allow`, classifyOwnerReply(text), 'allow');
  }
  for (const text of ['不行', '别发', '算了', '不要', 'no', '不给']) {
    eq(`「${text}」→ deny`, classifyOwnerReply(text), 'deny');
  }
  for (const text of ['随便你', '你看着办', '你决定', '你说了算', '随你']) {
    eq(`「${text}」→ delegate`, classifyOwnerReply(text), 'delegate');
  }
  eq('无关的话不算回复', classifyOwnerReply('今天天气不错'), null);
  eq('问句不误判', classifyOwnerReply('你觉得可以吗'), null);
  eq('空串', classifyOwnerReply('   '), null);
  eq('长句不误判', classifyOwnerReply('我觉得这个可以但是要不等明天再说吧'), null);
  eq('英文也行', classifyOwnerReply('sure'), 'allow');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
