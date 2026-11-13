/**
 * 配置默认值的单测：这些数字/开关会直接变成 Agent 的行为边界。
 * 跑法：npx tsx tests/unit/config.test.ts
 */

import { telegramDefaults } from '../../src/config.ts';

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

const d = telegramDefaults();

console.log('\n# 自由度：默认不拦');
eq('删除不审批', d.guard.deleteRevoke, 'auto');
eq('联系人写入不审批', d.guard.contactWrite, 'auto');

console.log('\n# 审批机制仍然在（只是默认不触发）');
eq('审批人缺省=白名单第一个', d.approverUserId, 0);
eq('审批码 5 分钟', d.approvalTtlMinutes, 5);

console.log('\n# 多端共存的安全默认');
eq('不改在线状态', d.presence, 'silent');
eq('不自动已读', d.autoMarkRead, false);
eq('不发 typing', d.typingIndicator, false);
eq('自己消息只归档', d.watchSelf, 'record');

console.log('\n# 监听与合并');
eq('私聊默认开', d.watchPrivate, true);
eq('群默认关', d.watchGroup, false);
eq('频道默认关', d.watchChannel, false);
eq('合并窗口 3s', d.mergeWindowMs, 3000);
eq('白名单默认空', [d.allowUsers.length, d.allowChats.length], [0, 0]);

console.log('\n# 媒体');
eq('给模型看的字节上限 8MB', d.maxMediaBytes, 8 * 1024 * 1024);
eq('ffmpeg 走 PATH', d.ffmpegPath, 'ffmpeg');

console.log('\n# 默认值每次都是新对象');
const a = telegramDefaults();
a.allowUsers.push({ id: 1, enabled: true });
eq('改一份不影响另一份', telegramDefaults().allowUsers.length, 0);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
