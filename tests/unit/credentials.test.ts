/**
 * 凭据解析的离线单测（无需注册 my.telegram.org）。
 * 跑法：npx tsx tests/unit/credentials.test.ts
 */

import {
  BUILTIN,
  credentialFingerprint,
  describeCredentials,
  maskHash,
  resolveCredentials,
} from '../../src/mtproto/credentials.ts';
import { classifyAuthError } from '../../src/mtproto/auth.ts';

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
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const noEnv = () => undefined;

console.log('\n# 优先级');
{
  const r = resolveCredentials({ env: noEnv });
  ok('无配置无 env → 内置', r.ok && r.value.source === 'builtin');
  ok('内置是 Telegram Desktop 凭据', r.ok && r.value.apiId === BUILTIN.apiId);
}
{
  const r = resolveCredentials({ apiId: 1234567, apiHash: 'a'.repeat(32), env: noEnv });
  ok('配置优先', r.ok && r.value.source === 'config' && r.value.apiId === 1234567);
}
{
  const env = (n: string) => (n === 'TG_API_ID' ? '7654321' : n === 'TG_API_HASH' ? 'b'.repeat(32) : undefined);
  const r = resolveCredentials({ env });
  ok('env 次之', r.ok && r.value.source === 'env' && r.value.apiId === 7654321);
}
{
  const env = (n: string) => (n === 'TG_API_ID' ? '7654321' : n === 'TG_API_HASH' ? 'b'.repeat(32) : undefined);
  const r = resolveCredentials({ apiId: 99, apiHash: 'c'.repeat(32), env });
  ok('配置压过 env', r.ok && r.value.apiId === 99);
}

console.log('\n# 非法组合');
{
  const r = resolveCredentials({ apiHash: 'd'.repeat(32), env: noEnv });
  ok('只有 hash → 报错', !r.ok, r.ok ? '' : r.error);
}
{
  const r = resolveCredentials({ apiId: 123, env: noEnv });
  ok('只有 id → 报错', !r.ok);
}
{
  const r = resolveCredentials({ apiId: 123, apiHash: 'not-a-hash' });
  ok('hash 格式不对 → 报错', !r.ok && (r.ok ? '' : r.error).includes('32 位'));
}
{
  const env = (n: string) => (n === 'TG_API_ID' ? '111' : undefined);
  const r = resolveCredentials({ env });
  ok('env 只有一个 → 报错', !r.ok && (r.ok ? '' : r.error).includes('成对'));
}

console.log('\n# 掩码与指纹');
{
  eq('hash 掩码', maskHash('b18441a1ff607e10a989891a5462e627'), 'b184…e627');
  const d = describeCredentials(BUILTIN);
  ok('面板不返回 hash 明文', !JSON.stringify(d).includes(BUILTIN.apiHash));
  const f1 = credentialFingerprint(BUILTIN);
  const f2 = credentialFingerprint({ ...BUILTIN });
  ok('指纹稳定', f1 === f2 && f1.startsWith('cred-'));
  ok('指纹不含原值', !f1.includes(String(BUILTIN.apiId)) && !f1.includes(BUILTIN.apiHash));
}

console.log('\n# api_id 相关错误翻译');
{
  const a = classifyAuthError('API_ID_PUBLISHED_FLOOD');
  eq('published flood 归类', a.kind, 'api-id');
  ok('提示换 api_id', a.human.includes('api_id'));
  eq('API_ID_INVALID', classifyAuthError('API_ID_INVALID').kind, 'api-id');
  eq('API_HASH_INVALID', classifyAuthError('API_HASH_INVALID').kind, 'api-id');
  eq('旧分支仍正确', classifyAuthError('PHONE_CODE_INVALID').kind, 'code-invalid');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
