/**
 * S-11：审计日志的单测（脱敏、截断、开关、轮转）。
 * 跑法：npx tsx tests/unit/audit.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditLog, compactAudit, redactAudit } from '../../src/audit.ts';

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

const root = mkdtempSync(join(tmpdir(), 'tg-audit-'));
const file = join(root, 'audit.jsonl');

try {
  console.log('\n# 脱敏');
  {
    const hash = 'b18441a1ff607e10a989891a5462e627';
    const long = 'A'.repeat(60);
    ok('32 位十六进制被替换', !redactAudit(`api_hash=${hash}`).includes(hash));
    ok('长串（session）被替换', !redactAudit('session ' + long).includes(long));
    ok('手机号被替换', !redactAudit('手机 +86 13812345678').includes('13812345678'));
    ok('普通文字不动', redactAudit('给张三发了首歌').includes('给张三发了首歌'));
    eq('键值对形式', redactAudit('api_hash=abcdef'), 'api_hash=[redacted]');
  }

  console.log('\n# 截断');
  {
    eq('短文本原样', compactAudit('hi'), 'hi');
    eq('换行压空格', compactAudit('a\nb\tc'), 'a b c');
    // 用中文（不会被当成 session 串）测截断
    const long = compactAudit('长'.repeat(500));
    ok('超长截断到 240', long.length === 240, String(long.length));
    ok('末尾是省略号', long.endsWith('…'));
    eq('对象转 JSON', compactAudit({ a: 1 }), '{"a":1}');
  }

  console.log('\n# 默认关闭时不写');
  {
    const log = new AuditLog(file, false);
    log.write({ tool: 'telegram_send_message', result: 'done' });
    ok('文件没被创建', !existsSync(file));
    eq('isEnabled 为 false', log.isEnabled, false);
  }

  console.log('\n# 打开后写 JSONL');
  {
    const log = new AuditLog(file, false);
    log.setEnabled(true);
    log.write({ tool: 'telegram_send_message', result: 'done', chatId: 123456789, outcome: '已发送' });
    log.write({ tool: 'telegram_delete_messages', result: 'denied' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    eq('两行', lines.length, 2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    eq('工具名', first.tool, 'telegram_send_message');
    eq('结果', first.result, 'done');
    eq('会话 id', first.chat_id, 123456789);
    ok('有时间戳', typeof first.ts === 'string' && first.ts.includes('T'));
    ok('不带 api_hash 字段', !('api_hash' in first));
  }

  console.log('\n# 写入时也脱敏');
  {
    const log = new AuditLog(join(root, 'audit2.jsonl'), true);
    log.write({
      tool: 'telegram_send_media',
      result: 'done',
      args: JSON.stringify({ file_path: 'C:\\secret\\session.txt', api_hash: 'b18441a1ff607e10a989891a5462e627' }),
    });
    const body = readFileSync(join(root, 'audit2.jsonl'), 'utf8');
    ok('不含完整 hash', !body.includes('b18441a1ff607e10a989891a5462e627'));
    ok('记了工具名', body.includes('telegram_send_media'));
  }

  console.log('\n# 超过上限会轮转');
  {
    const small = join(root, 'audit3.jsonl');
    const log = new AuditLog(small, true, { maxBytes: 64 * 1024 });
    // 先写一个超过上限的文件
    writeFileSync(small, 'x'.repeat(70 * 1024), 'utf8');
    log.write({ tool: 'telegram_x', result: 'done' });
    ok('旧文件被保留为 .1', existsSync(`${small}.1`), '');
    ok('新文件重新开始', statSync(small).size < 1024, String(statSync(small).size));
  }

  console.log('\n# 文件不存在时不会崩');
  {
    const nested = join(root, 'deep', 'dir', 'audit.jsonl');
    const log = new AuditLog(nested, true);
    log.write({ tool: 't', result: 'done' });
    ok('自动建目录并写入', existsSync(nested));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
