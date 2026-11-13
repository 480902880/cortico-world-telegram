/**
 * 下载重试分类、相册路径解析的单测。
 * 跑法：npx tsx tests/unit/retry.test.ts
 */

import { albumPaths, shouldRetryDownload } from '../../src/mtproto/client.ts';
import { parsePaths } from '../../src/tools.ts';

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

console.log('\n# 该不该重试下载');
{
  ok('超时 → 重试', shouldRetryDownload('ETIMEDOUT: request timed out'));
  ok('连接被重置 → 重试', shouldRetryDownload('read ECONNRESET'));
  ok('RPC 内部错误 → 重试', shouldRetryDownload('RPC_CALL_FAIL'));
  ok('限流 → 重试（由 guard 先处理）', shouldRetryDownload('FLOOD_WAIT_5'));

  ok('文件引用过期 → 不重试', !shouldRetryDownload('FILE_REFERENCE_EXPIRED'));
  ok('引用无效 → 不重试', !shouldRetryDownload('FILE_REFERENCE_INVALID'));
  ok('消息不存在 → 不重试', !shouldRetryDownload('MESSAGE_ID_INVALID'));
  ok('私有频道 → 不重试', !shouldRetryDownload('CHANNEL_PRIVATE'));
  ok('空消息 → 不重试', !shouldRetryDownload('MEDIA_EMPTY'));
  ok('空字符串 → 不重试', !shouldRetryDownload(''));
}

console.log('\n# 相册路径解析');
{
  eq('逗号分隔', albumPaths('a.jpg, b.jpg'), ['a.jpg', 'b.jpg']);
  eq('换行分隔', albumPaths('a.jpg\nb.jpg'), ['a.jpg', 'b.jpg']);
  eq('数组', albumPaths(['a.jpg', ' b.jpg ']), ['a.jpg', 'b.jpg']);
  eq('去重', albumPaths('a.jpg, a.jpg, b.jpg'), ['a.jpg', 'b.jpg']);
  eq('去掉引号', albumPaths('"C:\\x\\a.jpg"'), ['C:\\x\\a.jpg']);
  eq('空项丢掉', albumPaths('a.jpg,,  ,b.jpg'), ['a.jpg', 'b.jpg']);
  eq('最多 10 个', albumPaths(Array.from({ length: 15 }, (_, i) => `p${i}.jpg`)).length, 10);
  eq('空输入', albumPaths(''), []);
}

console.log('\n# 工具层路径解析（发给 world 之前）');
{
  eq('保序', parsePaths('x.png, y.png'), ['x.png', 'y.png']);
  eq('不截断（交给底层校验）', parsePaths(Array.from({ length: 12 }, (_, i) => `p${i}.png`)).length, 12);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
