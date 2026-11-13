/**
 * 引用正文格式化的单测。
 * 跑法：npx tsx tests/unit/quote.test.ts
 */

import { QUOTE_MAX_CHARS, compactQuote, formatQuoteMark } from '../../src/inbound/quote.ts';

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

console.log('\n# 带上正文');
{
  eq(
    '正文一起显示',
    formatQuoteMark(327, '我不给他找台阶'),
    '(回复 #327 「我不给他找台阶」)',
  );
  eq(
    '有发送者前缀',
    formatQuoteMark(12, 'Coo: 那你说怎么办'),
    '(回复 #12 「Coo: 那你说怎么办」)',
  );
}

console.log('\n# 没有正文时退回编号');
{
  eq('空串', formatQuoteMark(9, ''), '(回复 #9)');
  eq('全是空白', formatQuoteMark(9, '   \n\t '), '(回复 #9)');
  eq('undefined', formatQuoteMark(9, undefined), '(回复 #9)');
}

console.log('\n# 压缩与截断');
{
  eq('换行压成空格', compactQuote('第一行\n第二行\t第三行'), '第一行 第二行 第三行');
  const long = 'あ'.repeat(200);
  const out = compactQuote(long);
  eq('长度不超过上限', out.length, QUOTE_MAX_CHARS);
  ok('末尾是省略号', out.endsWith('…'), out.slice(-3));
  eq('刚好等于上限不截断', compactQuote('あ'.repeat(QUOTE_MAX_CHARS)).length, QUOTE_MAX_CHARS);
  ok('刚好等于上限没有省略号', !compactQuote('あ'.repeat(QUOTE_MAX_CHARS)).endsWith('…'));
}

console.log('\n# 编号原样保留');
{
  ok('负数编号', formatQuoteMark(-5, 'x').includes('#-5'), formatQuoteMark(-5, 'x'));
  ok('大编号', formatQuoteMark(1234567890, '').includes('#1234567890'));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
