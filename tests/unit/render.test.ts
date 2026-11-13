/**
 * 消息渲染的单测：媒体描述、时长/大小、转发与编辑标记。
 * 跑法：npx tsx tests/unit/render.test.ts
 */

import { formatDuration, formatFlags, formatMedia, formatReactions, formatSize } from '../../src/inbound/render.ts';
import { reactionSummary } from '../../src/mtproto/message-reactions.ts';

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

console.log('\n# 时长');
{
  eq('7 秒', formatDuration(7), '0:07');
  eq('65 秒', formatDuration(65), '1:05');
  eq('4 分 55 秒', formatDuration(295), '4:55');
  eq('超过一小时', formatDuration(3725), '1:02:05');
  eq('负数当 0', formatDuration(-3), '0:00');
}

console.log('\n# 大小');
{
  eq('字节', formatSize(820), '820 B');
  eq('KB', formatSize(12_600), '12.3 KB');
  eq('MB', formatSize(1_468_006), '1.4 MB');
  eq('非法值给空串', formatSize(-1), '');
}

console.log('\n# 媒体描述');
{
  eq('没有媒体', formatMedia(undefined), '');
  eq('纯图片', formatMedia({ kind: 'photo' }), '[photo]');
  eq('语音带时长', formatMedia({ kind: 'voice', durationSec: 7 }), '[voice 0:07]');
  eq(
    '歌带艺人标题与大小',
    formatMedia({ kind: 'audio', title: '木漏れ日のエール', durationSec: 295, size: 4_400_000 }),
    '[audio 木漏れ日のエール 4:55 4.2 MB]',
  );
  eq('贴纸带表情', formatMedia({ kind: 'sticker', emoji: '🐱' }), '[sticker 🐱]');
  eq('文档带文件名', formatMedia({ kind: 'document', fileName: 'report.pdf', size: 2048 }), '[document report.pdf 2.0 KB]');
  eq('视频带分辨率', formatMedia({ kind: 'video', width: 1280, height: 720, durationSec: 12 }), '[video 0:12 1280×720]');
  eq('投票用文件名承载问题', formatMedia({ kind: 'other', fileName: '投票：今晚吃啥' }), '[other 投票：今晚吃啥]');
  eq(
    '标题与文件名相同不重复',
    formatMedia({ kind: 'audio', title: 'song', fileName: 'song', durationSec: 60 }),
    '[audio song 1:00]',
  );
}

console.log('\n# 转发 / 编辑 / 话题');
{
  eq('都没有', formatFlags({}), []);
  eq('转发', formatFlags({ forwardedFrom: '某某频道' }), ['(转发自 某某频道)']);
  eq('已编辑', formatFlags({ edited: true }), ['(已编辑)']);
  eq(
    '组合顺序稳定',
    formatFlags({ forwardedFrom: 'A', edited: true, topicId: 66 }),
    ['(转发自 A)', '(已编辑)', '(话题 #66)'],
  );
}

console.log('\n# 已有的反应');
{
  eq('没有反应', formatReactions(undefined), '');
  eq('空数组', formatReactions([]), '');
  eq('单个', formatReactions([{ emoji: '👍', count: 3 }]), '[反应 👍3]');
  eq('一次算一个', formatReactions([{ emoji: '❤', count: 1 }]), '[反应 ❤]');
  eq('多个按顺序', formatReactions([{ emoji: '👍', count: 2 }, { emoji: '❤', count: 1 }]), '[反应 👍2 ❤]');
  const many = formatReactions(Array.from({ length: 12 }, (_, i) => ({ emoji: 'e' + i, count: 1 })));
  eq('最多显示 8 个（含前缀共 9 段）', many.split(' ').length, 9);
  ok('第九个之后被截掉', !many.includes('e8'), many);
}

console.log('\n# 从原始消息提取反应');
{
  eq('没字段', reactionSummary({}), undefined);
  eq('空结果', reactionSummary({ reactions: { results: [] } }), undefined);
  eq('正常提取', reactionSummary({ reactions: { results: [{ reaction: { emoticon: '👍' }, count: 5 }] } }), [{ emoji: '👍', count: 5 }]);
  eq('自定义表情有占位', reactionSummary({ reactions: { results: [{ reaction: { documentId: 7n }, count: 2 }] } }), [{ emoji: '自定义表情', count: 2 }]);
  eq('count 缺失按 1', reactionSummary({ reactions: { results: [{ reaction: { emoticon: '🔥' } }] } }), [{ emoji: '🔥', count: 1 }]);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
