/**
 * 懒加载的 MTProto 库：缺依赖时**不能**让扩展加载失败。
 * 跑法：npx tsx tests/unit/lib-lazy.test.ts
 *
 * 真实事故：市场装的包没有 node_modules，`lib.ts` 顶层 `import('teleproto')`
 * 直接把扩展加载搞崩，连"一键安装依赖"的面板都打不开。
 */

import * as lib from '../../src/mtproto/lib.ts';

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

console.log('\n# 模块加载本身绝不碰依赖');
{
  // 走 import 就成功（能执行到这里），说明顶层没有 await import('teleproto')
  ok('lib.ts 可以被导入', typeof lib.ensureLib === 'function');
  ok('提示文案提到「一键安装依赖」', lib.LIB_MISSING_HINT.includes('一键安装依赖'), lib.LIB_MISSING_HINT);
  ok('提示文案给出包名', lib.LIB_MISSING_HINT.includes('teleproto'), lib.LIB_MISSING_HINT);
}

console.log('\n# 未加载时用 Api 会给出人话，而不是 undefined 崩溃');
{
  if (!lib.libReady()) {
    let message = '';
    try {
      void (lib.Api as any).messages;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    ok('Api 取值抛人话', message.includes('一键安装依赖'), message);
  } else {
    console.log('  跳过：依赖已被前面的用例加载');
  }
}

console.log('\n# ensureLib 幂等且成功后 libReady 为真');
{
  const first = await lib.ensureLib();
  ok('拿到模块', typeof first.TelegramClient === 'function');
  ok('libReady 变真', lib.libReady());
  const second = await lib.ensureLib();
  ok('二次调用同一个对象', first === second);
}

console.log('\n# 加载后各门面可用');
{
  ok('Api.messages 有内容', Boolean((lib.Api as any).messages));
  ok('libVersion 不是 unknown', lib.libVersion() !== 'unknown', lib.libVersion());
  const info = lib.libInfo();
  ok('libInfo 报告 teleproto', info.id === 'teleproto');
  ok('论坛话题命名空间有结论', info.forum === 'messages' || info.forum === 'channels' || info.forum === null);
  const forum = lib.forumTopics();
  ok('forumTopics 与命名空间一致', (info.forum === null) === (forum === null));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
