/**
 * 登录状态机 / session 存储的离线单测（无网络、无账号）。
 * 跑法：npx tsx tests/unit/auth.test.ts
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthMachine, classifyAuthError, maskPhone, type AuthPort } from '../../src/mtproto/auth.ts';
import { SessionStore } from '../../src/mtproto/session-store.ts';
import type { AccountInfo } from '../../src/mtproto/port.ts';

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

/** 假端口：完全按脚本回应，不联网。 */
class FakePort implements AuthPort {
  calls: string[] = [];
  meResult: AccountInfo = { id: 777, username: 'probe_bot' };
  signInResult: 'ok' | 'password-needed' = 'ok';
  restoreError: string | null = null;
  session = 'x'.repeat(180);

  async connect(): Promise<void> {
    this.calls.push('connect');
    if (this.restoreError) throw new Error(this.restoreError);
  }
  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
  }
  async sendCode(phone: string): Promise<{ codeHash: string; viaApp: boolean }> {
    this.calls.push(`sendCode:${phone}`);
    return { codeHash: 'HASH', viaApp: true };
  }
  async signIn(_phone: string, _hash: string, code: string): Promise<'ok' | 'password-needed'> {
    this.calls.push(`signIn:${code}`);
    if (code === '00000') throw new Error('PHONE_CODE_INVALID');
    if (code === '55555') throw new Error('FLOOD_WAIT_42');
    return this.signInResult;
  }
  async checkPassword(pw: string): Promise<void> {
    this.calls.push('checkPassword');
    if (pw !== 'secret') throw new Error('PASSWORD_HASH_INVALID');
  }
  async me(): Promise<AccountInfo> {
    if (this.restoreError) throw new Error(this.restoreError);
    return this.meResult;
  }
  saveSession(): string {
    return this.session;
  }
  async logOut(): Promise<void> {
    this.calls.push('logOut');
  }
}

const dirs: string[] = [];
function freshStore(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'tg-auth-'));
  dirs.push(dir);
  return new SessionStore(dir);
}

async function main(): Promise<void> {
  console.log('\n# 掩码与错误分类');
  eq('maskPhone 国内号', maskPhone('+8613800138000'), '+86 138****8000');
  eq('maskPhone 短号', maskPhone('123'), '***');
  eq('FLOOD_WAIT 带秒数', classifyAuthError('FLOOD_WAIT_42').retryAfterSec, 42);
  eq('PHONE_CODE_INVALID', classifyAuthError('PHONE_CODE_INVALID').kind, 'code-invalid');
  eq('SESSION_PASSWORD_NEEDED', classifyAuthError('SESSION_PASSWORD_NEEDED').kind, 'password-needed');
  eq('AUTH_KEY_UNREGISTERED', classifyAuthError('AUTH_KEY_UNREGISTERED').kind, 'revoked');

  console.log('\n# 正常登录链路');
  {
    const store = freshStore();
    const port = new FakePort();
    const auth = new AuthMachine(port, store);

    let s = await auth.startLogin('+86 138-0013-8000');
    eq('发码后状态', s.step, 'code_sent');
    ok('手机号已掩码', !!s.phoneMasked && !s.phoneMasked.includes('0013'), String(s.phoneMasked));
    ok('未落盘 session', !store.present());

    s = await auth.submitCode('12345');
    eq('授权成功', s.step, 'authorized');
    eq('账号 id', s.account?.id, 777);
    ok('session 已落盘', store.present());
    const mode = statSync(store.paths.session).mode & 0o777;
    ok('权限不外泄（非 win 时检查）', process.platform === 'win32' || (mode & 0o077) === 0, mode.toString(8));
    ok('session 内容完整', store.read()?.length === 180);
    ok('登录后内存已清手机号', !JSON.stringify(auth.status()).includes('13800138000'));
  }

  console.log('\n# 两步验证');
  {
    const store = freshStore();
    const port = new FakePort();
    port.signInResult = 'password-needed';
    const auth = new AuthMachine(port, store);

    await auth.startLogin('+8613800138000');
    let s = await auth.submitCode('12345');
    eq('进入密码步骤', s.step, 'password_needed');
    s = await auth.submitPassword('wrong');
    eq('密码错误仍停在密码步骤', s.step, 'password_needed');
    s = await auth.submitPassword('secret');
    eq('密码正确后授权', s.step, 'authorized');
    ok('session 已落盘', store.present());
  }

  console.log('\n# 错误分支');
  {
    const store = freshStore();
    const port = new FakePort();
    const auth = new AuthMachine(port, store);
    await auth.startLogin('+8613800138000');
    let s = await auth.submitCode('00000');
    eq('验证码错误→回到 code_sent', s.step, 'code_sent');
    ok('错误文案可读', (s.detail ?? '').includes('验证码'));
    s = await auth.submitCode('55555');
    ok('FLOOD_WAIT 显示秒数', (s.detail ?? '').includes('42'), s.detail);
    ok('失败时不落 session', !store.present());
  }

  console.log('\n# 恢复与会话失效');
  {
    const store = freshStore();
    store.write('y'.repeat(200));
    const port = new FakePort();
    const auth = new AuthMachine(port, store);
    const s = await auth.restore();
    eq('恢复成功', s.step, 'authorized');
    eq('恢复后账号', s.account?.id, 777);
  }
  {
    const store = freshStore();
    store.write('y'.repeat(200));
    const port = new FakePort();
    port.restoreError = 'AUTH_KEY_UNREGISTERED';
    const auth = new AuthMachine(port, store);
    const s = await auth.restore();
    eq('会话失效', s.step, 'revoked');
    ok('死 session 已清除', !store.present());
  }

  console.log('\n# 登出');
  {
    const store = freshStore();
    store.write('z'.repeat(200));
    const port = new FakePort();
    const auth = new AuthMachine(port, store);
    const s = await auth.logout();
    eq('登出状态', s.step, 'idle');
    ok('本地 session 已清', !store.present());
    ok('走的是 auth.logOut（只注销本条）', port.calls.includes('logOut'));
    ok('从未触碰 resetAuthorizations', !port.calls.some((c) => /reset/i.test(c)));
  }

  console.log('\n# 坏 session 文件');
  {
    const store = freshStore();
    store.write('short');
    ok('过短视为未登录（write 直接清空）', !store.present());
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
