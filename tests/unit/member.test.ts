/**
 * 群成员 / 用户资料 / 静音换算的单测。
 * 跑法：npx tsx tests/unit/member.test.ts
 */

import { muteUntilOf, toMember, toUserInfo } from '../../src/mtproto/client.ts';

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

console.log('\n# 成员基本信息');
{
  const member = toMember({ id: 42, firstName: 'Alice', lastName: 'Chen', username: 'alicechen' });
  eq('id', member?.id, 42);
  eq('名字拼接', member?.name, 'Alice Chen');
  eq('用户名', member?.username, 'alicechen');
  ok('没有 admin 标记', member?.admin === undefined);
}

console.log('\n# 管理员判定');
{
  ok('Admin', toMember({ id: 1, firstName: 'A', participant: { className: 'ChannelParticipantAdmin' } })?.admin === true);
  ok('Creator', toMember({ id: 2, firstName: 'B', participant: { className: 'ChannelParticipantCreator' } })?.admin === true);
  ok('普通成员不算', toMember({ id: 3, firstName: 'C', participant: { className: 'ChannelParticipant' } })?.admin === undefined);
  ok('基础群管理员', toMember({ id: 4, firstName: 'D', participant: { className: 'ChatParticipantAdmin' } })?.admin === true);
}

console.log('\n# 名字兜底与异常');
{
  eq('没名字时用用户名', toMember({ id: 5, username: 'onlyname' })?.name, 'onlyname');
  eq('都没有时用 id', toMember({ id: 6 })?.name, '6');
  eq('没有 id → null', toMember({ firstName: 'x' }), null);
  eq('id=0 → null', toMember({ id: 0 }), null);
  eq('空对象 → null', toMember({}), null);
}

console.log('\n# 静音时长换算');
{
  const now = 1_760_000_000_000;
  eq('0 = 取消', muteUntilOf(0, now), 0);
  eq('-1 = 永久', muteUntilOf(-1, now), 2147483647);
  eq('60 分钟', muteUntilOf(60, now), Math.floor(now / 1000) + 3600);
  eq('非法值当取消', muteUntilOf(Number.NaN, now), 0);
}

console.log('\n# UserInfo 映射');
{
  const info = toUserInfo({ id: 9, firstName: 'Y', lastName: 'G', username: 'yg', phone: '10086' });
  eq('id', info?.id, 9);
  eq('用户名', info?.username, 'yg');
  eq('手机号', info?.phone, '10086');
  ok('非 bot 不带 bot 字段', info?.bot === undefined);
  eq('没有 id → null', toUserInfo({ firstName: 'x' }), null);
  ok('bot 标记', toUserInfo({ id: 3, bot: true })?.bot === true);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
