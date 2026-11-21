/**
 * 会话 id 归一化的单测（用户点选白名单依赖它）。
 * 跑法：npx tsx tests/unit/entity.test.ts
 */

import { mapEntity, mentionsUser, peerIdOf } from '../../src/mtproto/client.ts';

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

console.log('\n# User / Chat / Channel');
eq('用户取正 id', mapEntity({ className: 'User', id: 123456789, firstName: 'Test' })?.id, 123456789);
eq('用户名字拼接', mapEntity({ className: 'User', id: 1, firstName: 'A', lastName: 'B' })?.title, 'A B');
eq('没有名字时退回用户名', mapEntity({ className: 'User', id: 1, username: 'yg' })?.title, 'yg');
eq('Bot 打标', mapEntity({ className: 'User', id: 1, bot: true })?.bot, true);
eq('自己那条标记出来', mapEntity({ className: 'User', id: 1, self: true })?.title.includes('我自己'), true);

eq('老式群取负 id', mapEntity({ className: 'Chat', id: 42, title: 'G' })?.id, -42);
eq('老式群 kind=group', mapEntity({ className: 'Chat', id: 42 })?.kind, 'group');

eq('超级群 -100 前缀', mapEntity({ className: 'Channel', id: 1234567890, megagroup: true })?.id, -1001234567890);
eq('超级群 kind=group', mapEntity({ className: 'Channel', id: 1, megagroup: true })?.kind, 'group');
eq('频道 kind=channel', mapEntity({ className: 'Channel', id: 1 })?.kind, 'channel');
eq('频道也用 -100', mapEntity({ className: 'Channel', id: 5, title: 'C' })?.id, -1000000000005);

console.log('\n# 异常输入');
eq('没有 id → null', mapEntity({ className: 'User' }), null);
eq('未知类型 → null', mapEntity({ className: 'Message', id: 1 }), null);
eq('空对象 → null', mapEntity({}), null);

console.log('\n# peerIdOf 区分超级群与广播频道');
eq('PeerChannel 带 megagroup 实体 → group', peerIdOf({ peerId: { className: 'PeerChannel' }, chatId: -100123, chat: { className: 'Channel', megagroup: true } }).kind, 'group');
eq('PeerChannel 无 post 但有 fromId → group', peerIdOf({ peerId: { className: 'PeerChannel' }, chatId: -100123, fromId: { className: 'PeerUser', userId: 7 } }).kind, 'group');
eq('PeerChannel 带 post=true → channel', peerIdOf({ peerId: { className: 'PeerChannel' }, chatId: -100123, post: true }).kind, 'channel');

console.log('\n# mentionsUser 词边界匹配');
eq('精确 @alice 命中', mentionsUser({ message: 'hi @alice!' }, 1, 'alice'), true);
eq('@alice_bot 不误命中 @alice', mentionsUser({ message: 'hi @alice_bot' }, 1, 'alice'), false);
eq('邮箱 foo@alice.com 不误命中', mentionsUser({ message: 'mail foo@alice.com' }, 1, 'alice'), false);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
