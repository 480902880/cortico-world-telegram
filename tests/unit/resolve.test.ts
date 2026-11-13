/**
 * 会话名/用户名解析的纯函数单测。
 * 跑法：npx tsx tests/unit/resolve.test.ts
 */

import { usernameFrom } from '../../src/mtproto/client.ts';

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

console.log('\n# @username');
eq('裸 @', usernameFrom('@somebody'), 'somebody');
eq('不加 @ 的普通名字不算用户名', usernameFrom('Alice'), null);
eq('太短不给', usernameFrom('@ab'), null);
eq('带下划线', usernameFrom('@some_body'), 'some_body');
eq('带数字', usernameFrom('@user2024'), 'user2024');

console.log('\n# 链接');
eq('t.me', usernameFrom('t.me/somebody'), 'somebody');
eq('https', usernameFrom('https://t.me/somebody'), 'somebody');
eq('带参数', usernameFrom('https://t.me/somebody?start=1'), 'somebody');
eq('telegram.me', usernameFrom('telegram.me/somebody'), 'somebody');
eq('tg://resolve', usernameFrom('tg://resolve?domain=somebody'), 'somebody');

console.log('\n# 不该误判');
eq('中文名', usernameFrom('技术交流群'), null);
eq('空串', usernameFrom(''), null);
eq('只有空白', usernameFrom('   '), null);
eq('数字 id', usernameFrom('123456789'), null);
eq('负数 id', usernameFrom('-1001234567890'), null);
eq('普通网址', usernameFrom('https://example.com/x'), null);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
