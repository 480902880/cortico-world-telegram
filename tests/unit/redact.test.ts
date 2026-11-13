/**
 * 日志脱敏审计：凡是要进日志的敏感值，出参里都不能出现原文。
 * 跑法：npx tsx tests/unit/redact.test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maskPhone } from '../../src/mtproto/auth.ts';
import { credentialFingerprint, describeCredentials } from '../../src/mtproto/credentials.ts';
import { SessionStore } from '../../src/mtproto/session-store.ts';

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

const SECRET_SESSION = `1BVtsOK4Bu7X-${'x'.repeat(140)}==`;
const SECRET_HASH = 'b18441a1ff607e10a989891a5462e627';
const SECRET_PHONE = '+8613800138000';

console.log('\n# 手机号');
{
  const masked = maskPhone(SECRET_PHONE);
  ok('不回显完整号码', !masked.includes('13800138000'), masked);
  ok('保留可辨识片段', masked.length > 0);
  ok('空值不炸', typeof maskPhone('') === 'string');
}

console.log('\n# apiHash / 凭证');
{
  const described = describeCredentials({ apiId: 2040, apiHash: SECRET_HASH, source: 'config' } as never);
  const text = JSON.stringify(described);
  ok('不回显 apiHash', !text.includes(SECRET_HASH), text);
  ok('保留掩码字段', text.includes('apiHashMasked'));
  ok('apiId 可以出现（不是秘密）', text.includes('2040'));

  const fingerprint = credentialFingerprint({ apiId: 2040, apiHash: SECRET_HASH, source: 'config' } as never);
  ok('指纹不含原文', !String(fingerprint).includes(SECRET_HASH));
  ok('指纹短且稳定', String(fingerprint).length > 0 && String(fingerprint).length <= 24);
}

console.log('\n# 会话串（StringSession）');
{
  const dir = mkdtempSync(join(tmpdir(), 'tg-session-'));
  try {
    const store = new SessionStore(dir);
    store.write(SECRET_SESSION);
    const described = store.describe();
    const text = JSON.stringify(described);
    ok('不回显会话串', !text.includes(SECRET_SESSION), text);
    ok('读得回来（长度 > 100 才认）', described.present === true, JSON.stringify(described));
    ok('只回掩码', typeof described.masked === 'string' && described.masked.length > 0 && described.masked.includes('StringSession'));
    ok('报告字节数', typeof described.bytes === 'number' && described.bytes > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
