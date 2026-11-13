/**
 * 按会话类型的权限矩阵单测。
 * 跑法：npx tsx tests/unit/policy.test.ts
 */

import { actionForLocalSticker, decidePolicy } from '../../src/policy.ts';
import type { ActionKind, ChatKind, FilePolicy } from '../../src/policy.ts';

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

function verdict(kind: ChatKind, action: ActionKind, opts: { isBot?: boolean; filePolicy?: FilePolicy } = {}) {
  return decidePolicy({
    chatKind: kind,
    isBot: opts.isBot ?? false,
    action,
    filePolicy: opts.filePolicy ?? 'ask',
  }).verdict;
}

console.log('\n# 唱歌（翻唱）任何会话都放行');
{
  eq('私聊唱歌放行', verdict('user', 'song'), 'allow');
  eq('私聊唱歌即使 filePolicy=deny 也放行', verdict('user', 'song', { filePolicy: 'deny' }), 'allow');
  eq('群里唱歌放行', verdict('group', 'song'), 'allow');
  eq('频道唱歌放行', verdict('channel', 'song'), 'allow');
  eq('TG bot 唱歌放行', verdict('user', 'song', { isBot: true }), 'allow');
}

console.log('\n# 私聊真人：交流随便，文件按配置');
{
  for (const action of ['text', 'sticker', 'gif', 'voice'] as ActionKind[]) {
    eq(`${action} 放行`, verdict('user', action), 'allow');
  }
  eq('文件 + ask → 询问', verdict('user', 'file', { filePolicy: 'ask' }), 'ask');
  eq('文件 + auto → 放行', verdict('user', 'file', { filePolicy: 'auto' }), 'allow');
  eq('文件 + deny → 拒绝', verdict('user', 'file', { filePolicy: 'deny' }), 'deny');
  eq('危险操作交给既有 guard（这里放行）', verdict('user', 'danger'), 'allow');
}

console.log('\n# 群 / 频道：只能交流与表情语音');
{
  for (const kind of ['group', 'channel'] as ChatKind[]) {
    for (const action of ['text', 'sticker', 'gif', 'voice'] as ActionKind[]) {
      eq(`${kind} ${action} 放行`, verdict(kind, action), 'allow');
    }
    eq(`${kind} 文件一律拒绝（即使 auto）`, verdict(kind, 'file', { filePolicy: 'auto' }), 'deny');
    eq(`${kind} 危险操作拒绝`, verdict(kind, 'danger'), 'deny');
  }
}

console.log('\n# TG 机器人账号（私聊）：同群聊待遇');
{
  for (const action of ['text', 'sticker', 'gif', 'voice'] as ActionKind[]) {
    eq(`bot ${action} 放行`, verdict('user', action, { isBot: true }), 'allow');
  }
  eq('bot 文件拒绝（即使 auto）', verdict('user', 'file', { isBot: true, filePolicy: 'auto' }), 'deny');
  eq('bot 危险操作拒绝', verdict('user', 'danger', { isBot: true }), 'deny');
}

console.log('\n# 拒绝理由是人话');
{
  const r = decidePolicy({ chatKind: 'group', isBot: false, action: 'file', filePolicy: 'auto' });
  eq('有理由', r.verdict === 'deny' && Boolean(r.reason), true);
  eq('理由提到表情/语音', /表情|语音/.test(r.reason ?? ''), true);
}

console.log('\n# 本地表情按形态归类');
{
  eq('静态/动态贴纸 → sticker', actionForLocalSticker('sticker'), 'sticker');
  eq('gif → gif', actionForLocalSticker('gif'), 'gif');
  eq('jpg → file（图片算文件）', actionForLocalSticker('photo'), 'file');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
