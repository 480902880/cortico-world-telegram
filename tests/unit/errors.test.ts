/**
 * S-10：致命错误分类的单测（不联网，用假错误文本）。
 * 跑法：npx tsx tests/unit/errors.test.ts
 */

import { PEER_FLOOD_PAUSE_MS, classifyFatal, peerFloodAllows } from '../../src/mtproto/errors.ts';

let passed = 0;
let failed = 0;

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

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

console.log('\n# 会话失效 → 停机重登');
{
  for (const text of ['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'AUTH_KEY_INVALID']) {
    const info = classifyFatal(text);
    eq(`${text} → revoked`, info?.kind, 'revoked');
    ok(`${text} 要停机`, info?.stop === true);
    ok(`${text} 有中文提示`, Boolean(info?.human && /重新登录/.test(info.human)), info?.human);
  }
}

console.log('\n# 账号封禁 → 不重试');
{
  for (const text of ['USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'PHONE_NUMBER_BANNED']) {
    const info = classifyFatal(text);
    eq(`${text} → banned`, info?.kind, 'banned');
    ok(`${text} 要停机`, info?.stop === true);
  }
}

console.log('\n# 同一会话被两处使用');
{
  const info = classifyFatal('AUTH_KEY_DUPLICATED');
  eq('→ duplicated', info?.kind, 'duplicated');
  ok('要停机（否则继续重连会作废授权）', info?.stop === true);
  ok('提示里提到双开', Boolean(info?.human && /双开/.test(info.human)), info?.human);
}

console.log('\n# PEER_FLOOD → 不停机但限流陌生人');
{
  const info = classifyFatal('PEER_FLOOD');
  eq('→ peer-flood', info?.kind, 'peer-flood');
  ok('不整体停机', info?.stop === false);
  ok('暂停时长 24 小时', PEER_FLOOD_PAUSE_MS === 86_400_000);
}

console.log('\n# 非致命错误交给重试逻辑');
{
  eq('FLOOD_WAIT 不算致命', classifyFatal('FLOOD_WAIT_42'), null);
  eq('普通网络错误不算致命', classifyFatal('ECONNRESET'), null);
  eq('空串', classifyFatal(''), null);
  eq('小写也能认', classifyFatal('session_revoked')?.kind, 'revoked');
}

console.log('\n# 罚站期间能否发消息');
{
  const now = 5_000_000;
  const until = now + 60 * 60_000;
  eq('白名单会话照常', peerFloodAllows({ until, now, allowlisted: true }).ok, true);
  eq('陌生人被拦', peerFloodAllows({ until, now, allowlisted: false }).ok, false);
  const blocked = peerFloodAllows({ until, now, allowlisted: false });
  ok('拒绝理由带剩余分钟', !blocked.ok && /60 分钟/.test(blocked.reason), blocked.ok ? '' : blocked.reason);
  eq('罚站过期后恢复', peerFloodAllows({ until, now: until + 1, allowlisted: false }).ok, true);
  eq('从没被罚', peerFloodAllows({ until: 0, now, allowlisted: false }).ok, true);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
