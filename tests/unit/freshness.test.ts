/**
 * P-01：产物新鲜度校验的单测（用临时目录造一个迷你工程）。
 * 跑法：npx tsx tests/unit/freshness.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { checkWebuiFreshness, fingerprintFiles, writeMeta } from '../../scripts/freshness.mjs';

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

const root = mkdtempSync(join(tmpdir(), 'tg-fresh-'));
const write = (rel: string, body: string): string => {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
  return full;
};

try {
  write('src/webui/client.ts', 'export const a = 1;\n');
  write('src/webui/extra.ts', 'export const b = 2;\n');
  write('src/prompt/ENV_PROMPT.md', 'hi\n');
  write('dist/webui.js', 'built\n');

  console.log('\n# 指纹');
  {
    const files = [join(root, 'src/webui/client.ts')];
    const first = fingerprintFiles(root, files);
    eq('同样内容指纹相同', fingerprintFiles(root, files), first);
    write('src/webui/client.ts', 'export const a = 999;\n');
    ok('内容变了指纹就变', fingerprintFiles(root, files) !== first);
    const setA = fingerprintFiles(root, [join(root, 'src/webui/client.ts')]);
    write('src/webui/client.ts', 'export const a = 1;\n');
    ok('改回原文指纹回来', fingerprintFiles(root, files) === first, setA);
  }

  console.log('\n# 以前从没构建过');
  {
    const check = checkWebuiFreshness(root);
    eq('没有 meta → 不通过', check.ok, false);
    ok('理由提到 meta', !check.ok && /meta\.json/.test(check.reason), check.ok ? '' : check.reason);
  }

  console.log('\n# 构建后：指纹对得上');
  {
    const sourceHash = fingerprintFiles(root, [
      join(root, 'src/webui/client.ts'),
      join(root, 'src/webui/extra.ts'),
      join(root, 'src/prompt/ENV_PROMPT.md'),
    ]);
    writeMeta(root, { writeFile: writeFileSync, sourceHash, outFile: join(root, 'dist/webui.js') });
    eq('校验通过', checkWebuiFreshness(root).ok, true);
  }

  console.log('\n# 改了源码没重建 → 拦住');
  {
    write('src/webui/client.ts', 'export const a = 2;\n');
    const check = checkWebuiFreshness(root);
    eq('不通过', check.ok, false);
    ok('理由说明产物是旧的', !check.ok && /旧/.test(check.reason), check.ok ? '' : check.reason);
  }

  console.log('\n# 新增一个源文件也算改动');
  {
    write('src/webui/client.ts', 'export const a = 1;\n');
    write('src/webui/another.ts', 'export const c = 3;\n');
    eq('新增文件 → 不通过', checkWebuiFreshness(root).ok, false);
    // Windows 上 rmSync 会静默失败，必须 unlink 并确认真的没了
    unlinkSync(join(root, 'src/webui/another.ts'));
    eq('文件真的删掉了', existsSync(join(root, 'src/webui/another.ts')), false);
    eq('删掉后恢复', checkWebuiFreshness(root).ok, true);
  }

  console.log('\n# 产物被删 / meta 损坏');
  {
    unlinkSync(join(root, 'dist/webui.js'));
    eq('产物真的删掉了', existsSync(join(root, 'dist/webui.js')), false);
    const missing = checkWebuiFreshness(root);
    eq('缺产物 → 不通过', missing.ok, false);
    ok('理由提到 webui.js', !missing.ok && /webui\.js/.test(missing.reason), missing.ok ? '' : missing.reason);
    writeFileSync(join(root, 'dist/webui.meta.json'), '{坏掉的 json', 'utf8');
    const broken = checkWebuiFreshness(root);
    eq('meta 损坏 → 不通过', broken.ok, false);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
