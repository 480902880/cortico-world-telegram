/**
 * S-07：资源目录防手滑校验的单测。
 * 跑法：npx tsx tests/unit/resources-guard.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

import { checkResourceDir, dirLabel, dirSizeHint } from '../../src/resources-guard.ts';

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

const root = mkdtempSync(join(tmpdir(), 'tg-res-'));
const sub = join(root, 'rvc', 'output');
mkdirSync(sub, { recursive: true });
writeFileSync(join(sub, 'cover.mp3'), 'x');
const driveRoot = parse(root).root;

try {
  console.log('\n# 明显不该填的（应拒绝）');
  {
    const cases: Array<[string, string]> = [
      [driveRoot, '盘符根'],
      ['C:\\Windows', 'Windows 目录'],
      ['C:\\Windows\\System32', 'System32'],
      [process.env.USERPROFILE ?? '', '用户主目录'],
      ['', '空'],
      ['relative\\dir', '相对路径'],
    ];
    for (const [value, label] of cases) {
      if (!value) continue;
      const result = checkResourceDir(value);
      ok(`${label} → 拒绝`, !result.ok, result.ok ? '' : result.reason);
    }
  }

  console.log('\n# 不该拦的（应放行）');
  {
    const result = checkResourceDir(sub);
    ok('正常子目录 → 放行', result.ok, result.ok ? '' : result.reason);
    const parent = checkResourceDir(root);
    ok('临时根目录本身也能用（不是系统目录）', parent.ok, parent.ok ? '' : parent.reason);
  }

  console.log('\n# 文件不是目录');
  {
    const file = join(sub, 'cover.mp3');
    const result = checkResourceDir(file);
    ok('文件 → 拒绝', !result.ok);
    ok('理由说明是文件', !result.ok && /文件/.test(result.reason), result.ok ? '' : result.reason);
  }

  console.log('\n# 不存在 / 读不了');
  {
    const result = checkResourceDir(join(root, '不存在的目录'));
    ok('不存在 → 拒绝', !result.ok);
    ok('理由说明不存在', !result.ok && /不存在/.test(result.reason), result.ok ? '' : result.reason);
  }

  console.log('\n# 放行时返回规范化路径');
  {
    const result = checkResourceDir(`${sub}${process.platform === 'win32' ? '\\\\' : '/'}`);
    ok('末尾斜杠被去掉', result.ok && !/[\\/]$/.test(result.path.replace(/^[A-Za-z]:$/, '')), result.ok ? result.path : '');
  }

  console.log('\n# 文件太多的提醒');
  {
    const many = join(root, 'many');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 60; i += 1) writeFileSync(join(many, `f${i}.txt`), 'x');
    eq('小目录无提醒', dirSizeHint(many, 100), undefined);
    ok('超过阈值有提醒', Boolean(dirSizeHint(many, 10)), String(dirSizeHint(many, 10)));
  }

  console.log('\n# 显示名不暴露完整路径');
  {
    const label = dirLabel(sub);
    ok('只留末两级', label.includes('rvc') && !label.includes(tmpdir().split('\\').pop() ?? '___'), label);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
