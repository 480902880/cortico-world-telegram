/**
 * 「不许有假开关」的守卫测试。
 *
 * 起因：面板上出现过「消息合并窗口」「在线状态」「自动已读」「正在输入」这类配置项，
 * 界面上能改、能保存，但代码里根本没人读——用户以为改了就生效，其实什么都没发生。
 *
 * 规则：`behaviorFields()` 里每个不是 `guard.*` 的键，都必须在 `src/` 里
 * （除 settings.ts / config.ts 外）至少被引用一次。引用不到就是假开关，测试失败。
 *
 * 跑法：npx tsx tests/unit/settings-wired.test.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { behaviorFields } from '../../src/settings.ts';

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

const srcRoot = join(process.cwd(), 'src');

/** 收集 src 下所有 ts 文件的正文（排除 settings.ts 与 config.ts 的"声明"）。 */
function collectSources(): Array<{ file: string; body: string }> {
  const out: Array<{ file: string; body: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith('.ts')) out.push({ file: full, body: readFileSync(full, 'utf8') });
    }
  };
  walk(srcRoot);
  return out.filter(({ file }) => !file.endsWith('settings.ts') && !file.endsWith('config.ts'));
}

const sources = collectSources();
const fields = behaviorFields(true).filter((field) => !field.key.startsWith('guard.'));

console.log('\n# 每个面板字段都得有人读');
{
  ok('字段数量合理', fields.length > 10, String(fields.length));
  for (const field of fields) {
    const segments = field.key.split('.');
    // 单段键：出现即可；多段键（transport.proxy）：要求各段**相邻出现**，
    // 避免把别处的同名词（比如 lib.ts 里的 Proxy）当成实现
    const hit = sources.some(({ body }) => {
      if (body.includes(`'${field.key}'`)) return false;
      if (segments.length === 1) return new RegExp(`(cfg\\.|config\\.)?${segments[0]}\\b`).test(body);
      const glued = segments
        .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\S]{0,40}?');
      return new RegExp(glued, 'i').test(body);
    });
    ok(`「${field.label}」(${field.key}) 有实现`, hit);
  }
}

console.log('\n# 已知的假开关应当已被移除或实现');
{
  const keys = fields.map((field) => field.key);
  // 这两个曾长期是假开关：现在都实现了（presence → setOnline，autoMarkRead → markRead）
  ok('presence 在字段里', keys.includes('presence'));
  ok('autoMarkRead 在字段里', keys.includes('autoMarkRead'));
  ok('typingIndicator 在字段里', keys.includes('typingIndicator'));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
