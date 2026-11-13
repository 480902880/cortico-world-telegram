/**
 * 「配置项不许是死的」守卫测试。
 *
 * 起因：`ignoreBots`、`timezone`、`approvalTtlMinutes`、`guard.stickerSetWrite` 这些键
 * 曾长期只写在默认值里、代码没人读——面板上看着能配，实际什么都不发生。
 *
 * 规则：`telegramDefaults()` 里每一个**叶子键**，都必须在本文件之外被源码引用过。
 * 新增配置却没接线 → 这条测试直接红。
 *
 * 跑法：npx tsx tests/unit/config-wired.test.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { telegramDefaults } from '../../src/config.ts';

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

const root = process.cwd();
const files: string[] = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
  }
};
walk(join(root, 'src'));

const sources = files
  .filter((file) => !file.endsWith('config.ts'))
  .map((file) => readFileSync(file, 'utf8'));

/** 收集所有叶子键（含嵌套：guard.deleteRevoke、resources.voice…）。 */
function leaves(prefix: string, obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...leaves(full, value as Record<string, unknown>));
      continue;
    }
    out.push(full);
  }
  return out;
}

const all = leaves('', telegramDefaults() as unknown as Record<string, unknown>);

console.log('\n# 每个配置项都得有人读');
{
  ok('配置项数量合理', all.length > 20, String(all.length));
  const dead: string[] = [];
  for (const path of all) {
    const leaf = path.split('.').pop()!;
    const used = sources.some((body) => new RegExp(`\\b${leaf}\\b`).test(body));
    if (!used) dead.push(path);
  }
  ok('没有没人读的配置项', dead.length === 0, dead.join('、'));
}

console.log('\n# 曾经是假开关的几项，现在必须真的被读');
{
  for (const path of ['guard.deleteRevoke', 'presence', 'autoMarkRead', 'typingIndicator', 'auditLog', 'approvalTtlMinutes']) {
    ok(path, all.includes(path));
  }
}

console.log('\n# 已经删掉的死配置不该再出现');
{
  for (const path of ['ignoreBots', 'timezone', 'guard.stickerSetWrite']) {
    ok(`${path} 已移除`, !all.includes(path));
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
