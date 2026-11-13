/**
 * S-04：群里何时唤醒模型的纯判定单测（只认 @ / 回复，不认"点名"）。
 * 跑法：npx tsx tests/unit/trigger.test.ts
 */

import { shouldWakeForGroup } from '../../src/inbound/trigger.ts';
import type { GroupTriggerMode } from '../../src/inbound/trigger.ts';

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

function wake(opts: {
  mode?: GroupTriggerMode;
  mentionsMe?: boolean;
  repliesToMe?: boolean;
  senderAllowlisted?: boolean;
}): boolean {
  return shouldWakeForGroup({
    mode: opts.mode ?? 'mention_or_reply',
    mentionsMe: opts.mentionsMe ?? false,
    repliesToMe: opts.repliesToMe ?? false,
    senderAllowlisted: opts.senderAllowlisted ?? false,
  });
}

console.log('\n# mention：只认 @');
{
  eq('@ 了 → 唤醒', wake({ mode: 'mention', mentionsMe: true }), true);
  eq('回复它但没 @ → 不唤醒', wake({ mode: 'mention', repliesToMe: true }), false);
  eq('普通聊天 → 不唤醒', wake({ mode: 'mention' }), false);
}

console.log('\n# mention_or_reply（默认）');
{
  eq('@ 了 → 唤醒', wake({ mentionsMe: true }), true);
  eq('回复它的消息 → 唤醒', wake({ repliesToMe: true }), true);
  eq('路人的普通消息 → 不唤醒', wake({}), false);
}

console.log('\n# allowed_senders：只看人');
{
  eq('白名单用户说话 → 唤醒', wake({ mode: 'allowed_senders', senderAllowlisted: true }), true);
  eq('群友说话 → 不唤醒', wake({ mode: 'allowed_senders', senderAllowlisted: false }), false);
  eq('群里 @ 但不在白名单 → 不唤醒', wake({ mode: 'allowed_senders', mentionsMe: true }), false);
}

console.log('\n# all：老行为');
{
  eq('任何消息都唤醒', wake({ mode: 'all' }), true);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
