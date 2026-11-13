/**
 * 登录状态机：手机号 → 验证码 → 两步验证 → 授权成功。
 *
 * 设计要点：
 *  - 只依赖 `AuthPort`（`MtprotoPort` 的子集），可完全离线单测；
 *  - 所有操作串行（同一时刻只有一次 RPC 在跑），避免并发建连触发 AUTH_KEY_DUPLICATED；
 *  - **不记录**手机号明文、验证码、密码；手机号只在内存里，落盘的只有 session；
 *  - 登出只注销本条授权（`port.logOut()`），绝不 `resetAuthorizations`（PLAN §12.1）。
 */

import type { AccountInfo, AuthStatus } from './port.ts';
import type { SessionStore } from './session-store.ts';

/** 登录需要的端口子集。 */
export interface AuthPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendCode(phone: string): Promise<{ codeHash: string; viaApp: boolean }>;
  signIn(phone: string, codeHash: string, code: string): Promise<'ok' | 'password-needed'>;
  checkPassword(password: string): Promise<void>;
  me(): Promise<AccountInfo>;
  /** 导出本客户端 session 串。授权成功后立刻调用并落盘。 */
  saveSession(): string;
  /** 只注销本条授权。 */
  logOut(): Promise<void>;
}

export interface AuthLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOG: AuthLogger = { info() {}, warn() {}, error() {} };

/** 手机号掩码：`+8613800138000` → `+86 138****8000`。 */
export function maskPhone(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const plus = s.startsWith('+') ? '+' : '';
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return `${plus}${'*'.repeat(digits.length)}`;
  // 国家码长度：+1/+7 一位；其余按 12 位以上取两位（+86/+44/+81…），更长的少数情况也够用
  const ccLen = digits.startsWith('1') || digits.startsWith('7') ? 1 : digits.length >= 12 ? 2 : 1;
  const cc = digits.slice(0, ccLen);
  const body = digits.slice(ccLen);
  const head = body.slice(0, Math.max(1, Math.min(3, body.length - 4)));
  const tail = body.slice(-4);
  const stars = '*'.repeat(Math.max(0, body.length - head.length - 4));
  return `${plus}${cc} ${head}${stars}${tail}`;
}

/** 把库抛出来的 RPC 错误翻成人话；同时给出是否属于「需要重新登录」。 */
export function classifyAuthError(message: string): {
  kind: 'password-needed' | 'code-invalid' | 'code-expired' | 'phone-invalid' | 'flood' | 'revoked' | 'api-id' | 'other';
  human: string;
  retryAfterSec?: number;
} {
  const m = message.toUpperCase();
  const flood = /FLOOD_WAIT_(\d+)/.exec(m);
  if (flood) {
    const sec = Number(flood[1]);
    return { kind: 'flood', human: `请求太频繁，请等待 ${sec} 秒后重试`, retryAfterSec: sec };
  }
  if (m.includes('API_ID_PUBLISHED_FLOOD')) {
    return {
      kind: 'api-id',
      human: '这个 api_id 被大量公开使用，已被 Telegram 限流。去 my.telegram.org → API development tools 申请一份（免费，两分钟），填到面板的凭据里再重启 World。',
    };
  }
  if (m.includes('API_ID_INVALID')) {
    return { kind: 'api-id', human: 'api_id 不被认可；请检查面板或 .env 里的 api_id/api_hash 是否成对且正确' };
  }
  if (m.includes('API_HASH_INVALID') || m.includes('API_ID_HASH')) {
    return { kind: 'api-id', human: 'api_hash 与 api_id 不匹配；请成对重新填写' };
  }
  if (m.includes('SESSION_PASSWORD_NEEDED') || m.includes('PASSWORD_REQUIRED')) {
    return { kind: 'password-needed', human: '该账号开了两步验证，请输入密码' };
  }
  if (m.includes('PHONE_CODE_INVALID') || m.includes('PHONE_CODE_EMPTY') || m.includes('CODE_INVALID')) {
    return { kind: 'code-invalid', human: '验证码不对，请重新输入' };
  }
  if (m.includes('PHONE_CODE_EXPIRED')) return { kind: 'code-expired', human: '验证码已过期，请重新获取' };
  if (m.includes('PHONE_NUMBER_INVALID') || m.includes('PHONE_NUMBER_BANNED')) {
    return { kind: 'phone-invalid', human: '手机号无效或已被限制' };
  }
  if (m.includes('SESSION_REVOKED') || m.includes('AUTH_KEY_UNREGISTERED') || m.includes('USER_DEACTIVATED')) {
    return { kind: 'revoked', human: '会话已被其他设备终止，请重新登录' };
  }
  return { kind: 'other', human: message };
}

export class AuthMachine {
  private current: AuthStatus = { step: 'idle' };
  private phone: string | undefined;
  private codeHash: string | undefined;
  /** 串行链：所有状态迁移排队执行。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly port: AuthPort,
    private readonly store: SessionStore,
    private readonly log: AuthLogger = NOOP_LOG,
  ) {}

  status(): AuthStatus {
    return this.current;
  }

  /** 供面板显示「登录到哪一步」。 */
  private set(next: AuthStatus): AuthStatus {
    this.current = next;
    return next;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    // 链本身吞掉异常，避免一次失败堵死后续操作
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 启动时恢复：有 session 就连上去问 `me()`。
   * - 成功 → authorized 并返回账号
   * - 会话被终止 → 清本地 session，revoked
   * - 网络问题 → error，但**保留** session（下次还能试）
   */
  restore(): Promise<AuthStatus> {
    return this.enqueue(async () => {
      const saved = this.store.read();
      if (!saved) return this.set({ step: 'idle' });
      try {
        await this.port.connect();
        const account = await this.port.me();
        this.log.info('已用本地 session 恢复登录', { accountId: account.id });
        return this.set({ step: 'authorized', account });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const c = classifyAuthError(detail);
        if (c.kind === 'revoked') {
          this.store.clear();
          this.log.warn('会话已被其他设备终止，本地 session 已清除', { reason: c.human });
          return this.set({ step: 'revoked', detail: c.human });
        }
        this.log.warn('session 恢复失败（保留本地 session）', { reason: c.human });
        return this.set({ step: 'error', detail: c.human });
      }
    });
  }

  /** 第一步：发验证码。phone 需带国家码，如 +8613800138000。 */
  startLogin(phone: string): Promise<AuthStatus> {
    return this.enqueue(async () => {
      const raw = phone.trim();
      const masked = maskPhone(raw);
      if (!/^\+?\d{6,20}$/.test(raw.replace(/[\s-]/g, ''))) {
        return this.set({ step: this.current.step, phoneMasked: masked, detail: '手机号格式不对，需要带国家码，例如 +8613800138000' });
      }
      this.phone = raw.replace(/[\s-]/g, '');
      try {
        await this.port.connect();
        const { codeHash, viaApp } = await this.port.sendCode(this.phone);
        this.codeHash = codeHash;
        this.log.info('验证码已发送', { phone: masked, viaApp });
        return this.set({
          step: 'code_sent',
          phoneMasked: masked,
          detail: viaApp ? '验证码已发送到你的 Telegram 客户端（App 内消息）' : '验证码已通过短信发送',
        });
      } catch (error) {
        const c = classifyAuthError(error instanceof Error ? error.message : String(error));
        this.log.warn('发送验证码失败', { reason: c.human });
        return this.set({ step: 'error', phoneMasked: masked, detail: c.human });
      }
    });
  }

  /** 第二步：提交验证码。可能直接成功，也可能要求两步验证密码。 */
  submitCode(code: string): Promise<AuthStatus> {
    return this.enqueue(async () => {
      if (!this.phone || !this.codeHash) {
        return this.set({ step: 'idle', detail: '请先发送验证码' });
      }
      const value = code.trim();
      if (!/^\d{3,8}$/.test(value)) {
        return this.set({ ...this.current, detail: '验证码应为 3–8 位数字' });
      }
      try {
        const result = await this.port.signIn(this.phone, this.codeHash, value);
        if (result === 'password-needed') {
          this.log.info('需要两步验证密码');
          return this.set({ step: 'password_needed', phoneMasked: maskPhone(this.phone) });
        }
        return await this.finishAuthorized();
      } catch (error) {
        const c = classifyAuthError(error instanceof Error ? error.message : String(error));
        if (c.kind === 'password-needed') {
          return this.set({ step: 'password_needed', phoneMasked: maskPhone(this.phone) });
        }
        this.log.warn('验证码登录失败', { kind: c.kind, reason: c.human });
        return this.set({ step: c.kind === 'revoked' ? 'revoked' : 'code_sent', phoneMasked: maskPhone(this.phone), detail: c.human });
      }
    });
  }

  /** 第三步：两步验证密码。 */
  submitPassword(password: string): Promise<AuthStatus> {
    return this.enqueue(async () => {
      if (this.current.step !== 'password_needed') {
        return this.set({ ...this.current, detail: '当前不需要两步验证密码' });
      }
      if (!password) return this.set({ ...this.current, detail: '密码不能为空' });
      try {
        await this.port.checkPassword(password);
        return await this.finishAuthorized();
      } catch (error) {
        const c = classifyAuthError(error instanceof Error ? error.message : String(error));
        this.log.warn('两步验证失败', { kind: c.kind });
        return this.set({ step: 'password_needed', phoneMasked: this.phone ? maskPhone(this.phone) : undefined, detail: c.kind === 'other' ? '密码不对' : c.human });
      }
    });
  }

  /** 授权成功：落 session、清内存里的手机号与验证码哈希。 */
  private async finishAuthorized(): Promise<AuthStatus> {
    const session = this.port.saveSession();
    if (!session) {
      return this.set({ step: 'error', detail: '登录成功但拿不到 session 串，请重试' });
    }
    this.store.write(session);
    let account: AccountInfo | undefined;
    try {
      account = await this.port.me();
    } catch {
      account = undefined;
    }
    this.phone = undefined;
    this.codeHash = undefined;
    this.log.info('登录成功', { accountId: account?.id ?? 0, session: this.store.describe().masked });
    return this.set({ step: 'authorized', account });
  }

  /** 登出：只注销本条授权 + 清本地 session。 */
  logout(): Promise<AuthStatus> {
    return this.enqueue(async () => {
      try {
        await this.port.logOut();
      } catch (error) {
        // 网络失败也要清本地，否则下次启动会拿死 key 重试
        this.log.warn('auth.logOut 失败，仍然清理本地 session', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      this.store.clear();
      this.phone = undefined;
      this.codeHash = undefined;
      try {
        await this.port.disconnect();
      } catch {
        // 忽略
      }
      return this.set({ step: 'idle' });
    });
  }

  /** 外部（更新桥/连接监督）发现会话失效时调用。 */
  markRevoked(detail: string): AuthStatus {
    this.store.clear();
    this.phone = undefined;
    this.codeHash = undefined;
    this.log.warn('会话失效', { detail });
    return this.set({ step: 'revoked', detail });
  }
}
