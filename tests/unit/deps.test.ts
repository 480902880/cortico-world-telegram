/**
 * 依赖自检的纯逻辑单测（只测 probeDeps / resolvePackageRoot，不跑 npm）。
 * 跑法：npx tsx tests/unit/deps.test.ts
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeDeps, resolvePackageRoot } from '../../src/deps.ts';

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

const root = mkdtempSync(join(tmpdir(), 'tg-deps-'));

try {
  console.log('\n# 包根目录反推（ctx.packageDir 不可信）');
  {
    const fakeRoot = join(root, 'pkg-a');
    mkdirSync(join(fakeRoot, 'src'), { recursive: true });
    writeFileSync(join(fakeRoot, 'package.json'), JSON.stringify({ name: 'cortico-world-telegram' }));
    const moduleUrl = new URL(`file:///${join(fakeRoot, 'src', 'world.ts').replace(/\\/g, '/')}`);
    const wrongFallback = join(root, 'deployment');
    mkdirSync(wrongFallback, { recursive: true });
    eq('从模块位置找到包根', resolvePackageRoot(moduleUrl.href, wrongFallback), fakeRoot);

    const other = join(root, 'pkg-b');
    mkdirSync(join(other, 'src'), { recursive: true });
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'some-other-world' }));
    const otherUrl = new URL(`file:///${join(other, 'src', 'index.ts').replace(/\\/g, '/')}`);
    eq('名字对不上就退回 fallback', resolvePackageRoot(otherUrl.href, wrongFallback), wrongFallback);
  }

  console.log('\n# 全新目录（什么都没装）');
  {
    const status = probeDeps(root);
    ok('没有 node_modules', !status.hasNodeModules);
    ok('没有 dist', !status.hasDist);
    ok('不可用', !status.ready);
    ok('缺失项有整包提示', status.missing.some((item) => item.includes('node_modules')));
    ok('报出 node 版本', status.node.startsWith('v'));
  }

  console.log('\n# 只装了 node_modules（没构建面板）');
  {
    mkdirSync(join(root, 'node_modules', 'teleproto'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'telegram'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'tsx'), { recursive: true });
    const status = probeDeps(root);
    ok('node_modules 有了', status.hasNodeModules);
    ok('仍缺 dist', !status.hasDist);
    ok('仍不可用（缺面板产物）', !status.ready);
    ok('不再报 teleproto 缺失', !status.missing.includes('teleproto'));
  }

  console.log('\n# 依赖 + 面板产物齐了');
  {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'webui.js'), '// bundle');
    const status = probeDeps(root);
    ok('hasDist', status.hasDist);
    ok('可用', status.ready);
    ok('没有缺失项', status.missing.length === 0, status.missing.join(','));
  }

  console.log('\n# 缺 teleproto 但别的不缺');
  {
    // 这台机器 rmSync 会静默失败，用改名让目录"消失"
    renameSync(join(root, 'node_modules', 'teleproto'), join(root, 'node_modules', '.teleproto-hidden'));
    const status = probeDeps(root);
    ok('缺 teleproto', status.missing.some((item) => item.includes('teleproto')), status.missing.join(','));
    ok('不可用', !status.ready);
  }

  console.log('\n# 安装中标记');
  {
    const status = probeDeps(root, true);
    ok('透传 installing', status.installing === true);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
