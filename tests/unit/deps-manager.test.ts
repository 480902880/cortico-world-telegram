/**
 * D-01/D-02：包管理器探测的单测。
 * 跑法：npx tsx tests/unit/deps-manager.test.ts
 *
 * 断言顺序：Coo 自带 pnpm → 系统 pnpm → 系统 npm → null，以及候选路径的布局。
 * 注意 Windows 路径大小写不敏感，所以每个用例都用独立的临时根目录。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bundledPnpmCandidates, resolvePackageManager } from '../../src/deps.ts';

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

const made: string[] = [];
function tempRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tg-deps-${tag}-`));
  made.push(dir);
  return dir;
}

/** 在 exeDir 下摆一个"打包好的 Coo"（pnpm.cjs 到位）。 */
function plantBundledPnpm(exeDir: string): void {
  const bin = join(exeDir, 'resources', 'app', 'node_modules', 'pnpm', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'pnpm.cjs'), '// fake pnpm\n');
}

try {
  console.log('\n# 候选路径：布局覆盖');
  {
    const exe = join(tempRoot('layout'), 'Coopanion.exe');
    const candidates = bundledPnpmCandidates(exe);
    ok('至少 3 个候选', candidates.length >= 3, String(candidates.length));
    ok('Windows/Linux 布局', candidates.some((p) => /resources[\\/]app[\\/]node_modules/.test(p)));
    ok('macOS 布局（Resources 大写）', candidates.some((p) => /Resources[\\/]app/.test(p)));
    ok('全部以 pnpm.cjs 结尾', candidates.every((p) => p.endsWith('pnpm.cjs')));
  }

  console.log('\n# 有 Coo 自带 pnpm 时优先用它');
  {
    const dir = tempRoot('bundled');
    const exe = join(dir, 'Coopanion.exe');
    plantBundledPnpm(dir);
    const manager = resolvePackageManager(exe);
    eq('选 bundled-pnpm', manager?.kind, 'bundled-pnpm');
    eq('用宿主 exe 当 node', manager?.command, exe);
    ok('参数带 pnpm.cjs 路径', manager?.baseArgs[0]?.endsWith('pnpm.cjs') === true, String(manager?.baseArgs[0]));
    eq('开 ELECTRON_RUN_AS_NODE', manager?.env.ELECTRON_RUN_AS_NODE, '1');
    ok('名字说明来源', /Coo/.test(manager?.label ?? ''), manager?.label);
  }

  console.log('\n# 没有自带 pnpm 时回落到系统');
  {
    const exe = join(tempRoot('system'), 'Coopanion.exe');
    const manager = resolvePackageManager(exe);
    ok('回落成功', manager !== null, '这台机器一个都没有？');
    if (manager) {
      ok('不是 bundled（该目录下没有）', manager.kind !== 'bundled-pnpm', manager.kind);
      ok('名字是系统级', /系统/.test(manager.label), manager.label);
      ok('命令非空', manager.command.length > 0, manager.command);
    }
  }

  console.log('\n# 一个都没有 → null（面板给出人话提示）');
  {
    const exe = join(tempRoot('none'), 'Coopanion.exe');
    const savedPath = process.env.PATH;
    const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      process.env.PATH = join(tempRoot('empty-path'), 'bin');
      Object.defineProperty(process, 'platform', { value: 'linux' });
      eq('返回 null', resolvePackageManager(exe), null);
    } finally {
      process.env.PATH = savedPath;
      if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
      else Reflect.deleteProperty(process, 'platform');
    }
  }
} finally {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
