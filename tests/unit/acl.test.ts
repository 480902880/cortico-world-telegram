/**
 * S-09：Windows ACL 加固的构造与执行单测。
 * 跑法：npx tsx tests/unit/acl.test.ts
 *
 * 断言两步：命令长得对（纯函数），以及在 Windows 上真的能跑通。
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aclPlan, currentUserName, hardenFileAcl } from '../../src/mtproto/acl.ts';

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

console.log('\n# 命令构造');
{
  const steps = aclPlan('C:\\data\\session.txt', 'PC\\alice');
  eq('两步', steps.length, 2);
  eq('第一步关继承', steps[0]!.args, ['C:\\data\\session.txt', '/inheritance:r']);
  ok('第二步是 grant:r', steps[1]!.args.includes('/grant:r'));
  const grants = steps[1]!.args.slice(2);
  ok('给 SYSTEM 授权', grants.includes('*S-1-5-18:(F)'), grants.join(' '));
  ok('给管理员组授权', grants.includes('*S-1-5-32-544:(F)'), grants.join(' '));
  ok('给本人授权', grants.includes('PC\\alice:(F)'), grants.join(' '));
  ok('用 SID 而不是本地化组名', !grants.some((g) => /Administrators/i.test(g)), grants.join(' '));
}

console.log('\n# 没有用户名时不硬塞怪东西');
{
  const steps = aclPlan('/tmp/session.txt', '   ');
  eq('只剩两条授权', steps[1]!.args.length, 4);
  ok('没有空用户条目', !steps[1]!.args.some((a) => a.trim() === ':(F)'), steps[1]!.args.join(' '));
}

console.log('\n# 用户名形态');
{
  const name = currentUserName();
  ok('非空', name.length > 0, name);
  ok('不含引号/空格包裹', !/^".*"$/.test(name), name);
}

console.log('\n# 真跑一次（仅 Windows）');
{
  if (process.platform !== 'win32') {
    console.log('  跳过：非 Windows');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'tg-acl-'));
    const file = join(dir, 'session.txt');
    try {
      writeFileSync(file, 'fake-session', { encoding: 'utf8', mode: 0o600 });
      const result = await hardenFileAcl(file);
      ok('加固成功', result.ok && !result.skipped, result.reason ?? '');
      ok('文件还在（没被误删）', existsSync(file));
      ok('内容没被动过', statSync(file).size === 'fake-session'.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
