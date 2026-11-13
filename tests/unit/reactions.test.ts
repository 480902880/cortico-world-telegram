/**
 * 反应更新解析的单测。
 * 跑法：npx tsx tests/unit/reactions.test.ts
 */

import { parseReactionUpdate } from '../../src/mtproto/reactions.ts';
import type { ChatKind } from '../../src/mtproto/port.ts';

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

/** 假的 peer 解析器：按存在哪个字段判断类型。 */
const resolve = (peer: any): { id: number; kind: ChatKind } => {
  if (peer?.userId) return { id: Number(peer.userId), kind: 'user' };
  if (peer?.chatId) return { id: -Number(peer.chatId), kind: 'group' };
  if (peer?.channelId) return { id: -1000000000000 - Number(peer.channelId), kind: 'channel' };
  return { id: 0, kind: 'user' };
};

const emoji = (value: string): any => ({ reaction: { emoticon: value } });

console.log('\n# 私聊里有人点了 ❤️');
{
  const update = {
    className: 'UpdateMessageReactions',
    peer: { userId: 5064811594 },
    msgId: 270,
    reactions: { results: [emoji('❤')] },
    recentReactions: [{ userId: 5064811594 }],
  };
  const parsed = parseReactionUpdate(update, resolve);
  eq('会话 id', parsed?.chatId, 5064811594);
  eq('会话类型', parsed?.chatKind, 'user');
  eq('消息 id', parsed?.messageId, 270);
  eq('谁点的', parsed?.userId, 5064811594);
  eq('表情', parsed?.emoticons, ['❤']);
  eq('不是取消', parsed?.removed, false);
}

console.log('\n# 多个表情去重');
{
  const update = {
    className: 'UpdateMessageReactions',
    peer: { userId: 1 },
    msgId: 5,
    reactions: { results: [emoji('👍'), emoji('👍'), emoji('🔥')] },
  };
  eq('去重后两个', parseReactionUpdate(update, resolve)?.emoticons, ['👍', '🔥']);
}

console.log('\n# 取消反应（集合变空）');
{
  const update = {
    className: 'UpdateMessageReactions',
    peer: { userId: 1 },
    msgId: 9,
    reactions: { results: [] },
    recentReactions: [{ userId: 1, reaction: [] }],
  };
  const parsed = parseReactionUpdate(update, resolve);
  eq('标记为取消', parsed?.removed, true);
  eq('没有表情', parsed?.emoticons, []);
}

console.log('\n# 群 / 频道');
{
  const group = parseReactionUpdate(
    { className: 'UpdateMessageReactions', peer: { chatId: 123 }, msgId: 7, reactions: { results: [emoji('🎉')] } },
    resolve,
  );
  eq('群 id 为负', group?.chatId, -123);
  eq('群类型', group?.chatKind, 'group');

  const channel = parseReactionUpdate(
    { className: 'UpdateMessageReactions', peer: { channelId: 456 }, msgId: 8, reactions: { results: [emoji('🎵')] } },
    resolve,
  );
  eq('频道 id', channel?.chatId, -1000000000456);
  eq('频道类型', channel?.chatKind, 'channel');
}

console.log('\n# 自定义表情');
{
  const update = {
    className: 'UpdateMessageReactions',
    peer: { userId: 1 },
    msgId: 3,
    reactions: { results: [{ reaction: { documentId: 999n } }] },
  };
  eq('给出可读占位', parseReactionUpdate(update, resolve)?.emoticons, ['自定义表情']);
}

console.log('\n# 不该认的输入');
{
  eq('别的 update 类型', parseReactionUpdate({ className: 'UpdateNewMessage' }, resolve), null);
  eq('没有 msgId', parseReactionUpdate({ className: 'UpdateMessageReactions', peer: { userId: 1 } }, resolve), null);
  eq('peer 解析不出来', parseReactionUpdate({ className: 'UpdateMessageReactions', msgId: 1 }, resolve), null);
  eq('msgId 非法', parseReactionUpdate({ className: 'UpdateMessageReactions', peer: { userId: 1 }, msgId: -3 }, resolve), null);
  eq('解析器抛错也不崩', parseReactionUpdate(
    { className: 'UpdateMessageReactions', peer: { userId: 1 }, msgId: 1 },
    () => { throw new Error('boom'); },
  ), null);
}

console.log('\n# bot 账号也会收到另一类 update');
{
  const parsed = parseReactionUpdate(
    { className: 'UpdateBotMessageReaction', peer: { userId: 2 }, msgId: 11, reactions: { results: [emoji('👀')] } },
    resolve,
  );
  eq('同样能解析', parsed?.emoticons, ['👀']);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
