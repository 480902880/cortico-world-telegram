/**
 * 登录态与运行态的本地存储。
 *
 * 安全约束（PLAN §12 / §8-13）：
 *  - session 串 = 账号完全控制权，只落 `data/telegram/session.txt`，权限 0600；
 *  - 原子写（tmp → rename），断电不会留下半截串；
 *  - 任何日志、面板、错误信息只出现掩码，不出现原文；
 *  - 与 Telegram Desktop 的 tdata 无关，本模块从不读写它。
 */

import { existsSync, mkdirSync, readFileSync, statSync, chmodSync, writeFileSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hardenFileAcl } from './acl.ts';

const SESSION_FILE = 'session.txt';
const STATE_FILE = 'state.json';
const LOCK_FILE = 'instance.lock';
const TMP_SUFFIX = '.tmp';

/** `data/telegram/` 下的全部路径。 */
export interface TelegramPaths {
  dir: string;
  session: string;
  state: string;
  lock: string;
  media: string;
}

export function telegramPaths(dataDir: string): TelegramPaths {
  const dir = join(dataDir, 'telegram');
  return {
    dir,
    session: join(dir, SESSION_FILE),
    state: join(dir, STATE_FILE),
    lock: join(dir, LOCK_FILE),
    media: join(dir, 'media'),
  };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * 删单个文件。
 *
 * 实测（Windows + 本机环境）：`rmSync(p, { force: true })` 会**静默失败**——不抛错、文件仍在。
 * `unlinkSync` 正常。所以这里以 unlink 为主，rmSync 只作兜底。
 */
function removeFile(path: string): void {
  try {
    if (!existsSync(path)) return;
    unlinkSync(path);
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      // 交给上层：调用方会在下次读时视为未登录
    }
  }
}

/** 原子写 + 收紧权限。先写 tmp 再 rename，避免半截内容被当成有效 session。 */
/** 原子异步写：tmp → chmod → rename（不阻塞事件循环）。 */
async function writeSecretAsync(file: string, content: string): Promise<void> {
  const tmp = `${file}${TMP_SUFFIX}`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    // Windows 上 chmod 只影响只读位
  }
  await rename(tmp, file);
}
function writeSecret(path: string, content: string): void {
  const tmp = `${path}${TMP_SUFFIX}`;
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows 上 chmod 只影响只读位；失败不致命，权限由 ACL 决定
  }
  renameSync(tmp, path);
}

/** session 串的掩码：只留长度与末 4 位，用于面板/日志确认「有没有、是不是这条」。 */
export function maskSession(value: string): string {
  const s = value.trim();
  if (!s) return '';
  const tail = s.slice(-4);
  return `StringSession(len=${s.length}, …${tail})`;
}

export class SessionStore {
  readonly paths: TelegramPaths;

  constructor(dataDir: string) {
    this.paths = telegramPaths(dataDir);
    ensureDir(this.paths.dir);
  }

  /** 读 session；不存在或明显损坏（长度 < 100、含空白）一律当未登录。 */
  read(): string | null {
    if (!existsSync(this.paths.session)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.paths.session, 'utf8').trim();
    } catch {
      return null;
    }
    if (raw.length < 100 || /\s/.test(raw)) return null;
    return raw;
  }

  present(): boolean {
    return this.read() !== null;
  }

  /** 写入（原子、0600）。传空串等于清除。 */
  write(session: string): void {
    const value = session.trim();
    if (!value) {
      this.clear();
      return;
    }
    writeSecret(this.paths.session, value);
    // S-09：Windows 上 chmod 不够，补一次 ACL 加固（best-effort，失败不影响登录）
    void hardenFileAcl(this.paths.session).catch(() => undefined);
  }

  clear(): void {
    removeFile(this.paths.session);
    removeFile(`${this.paths.session}${TMP_SUFFIX}`);
  }

  /** 面板展示用；不含明文。 */
  describe(): { present: boolean; masked: string; bytes: number } {
    const raw = this.read();
    if (!raw) return { present: false, masked: '', bytes: 0 };
    let bytes = 0;
    try {
      bytes = statSync(this.paths.session).size;
    } catch {
      bytes = raw.length;
    }
    return { present: true, masked: maskSession(raw), bytes };
  }

  /** 文件权限是否已收紧（面板健康检查用；Windows 上恒为 true）。 */
  permissionOk(): boolean {
    if (!existsSync(this.paths.session)) return true;
    if (process.platform === 'win32') return true;
    try {
      return (statSync(this.paths.session).mode & 0o077) === 0;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 运行态：lastSeenId（补课用）+ 双开锁
// ---------------------------------------------------------------------------

export interface ChatCursor {
  lastSeenId: number;
  lastSeenTs: number;
}

export interface RunState {
  /** chatId → 已处理到的最大 message id。 */
  chats: Record<string, ChatCursor>;
}

export interface StateStoreOptions {
  /** 攒多久写一次盘（默认 1 秒）。 */
  debounceMs?: number;
  /** 超过这个时长没动静的会话游标会被清掉（默认 30 天）。 */
  keepDays?: number;
  /** 会话游标总数上限（默认 2000）。 */
  maxChats?: number;
  now?: () => number;
  /** 注入写盘实现（测试用）。 */
  write?: (path: string, body: string) => Promise<void>;
}

export class StateStore {
  private cache: RunState | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly keepMs: number;
  private readonly maxChats: number;
  private readonly now: () => number;
  private readonly write: (path: string, body: string) => Promise<void>;

  constructor(
    private readonly paths: TelegramPaths,
    opts: StateStoreOptions = {},
  ) {
    this.debounceMs = Math.max(0, opts.debounceMs ?? 1000);
    this.keepMs = Math.max(1, opts.keepDays ?? 30) * 24 * 3600_000;
    this.maxChats = Math.max(1, opts.maxChats ?? 2000);
    this.now = opts.now ?? (() => Date.now());
    this.write = opts.write ?? writeSecretAsync;
  }

  read(): RunState {
    if (this.cache) return this.cache;
    if (!existsSync(this.paths.state)) {
      this.cache = { chats: {} };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.paths.state, 'utf8')) as Partial<RunState>;
      const chats: Record<string, ChatCursor> = {};
      for (const [k, v] of Object.entries(parsed.chats ?? {})) {
        if (v && typeof v === 'object' && Number.isFinite(v.lastSeenId)) {
          chats[k] = { lastSeenId: Number(v.lastSeenId), lastSeenTs: Number(v.lastSeenTs) || 0 };
        }
      }
      this.cache = { chats };
    } catch {
      this.cache = { chats: {} };
    }
    return this.cache;
  }

  /** 只前进不后退：乱序/补课都不会把游标拉回去。**只改内存，攒批写盘。** */
  bump(chatId: number, messageId: number, at = Date.now()): void {
    const state = this.read();
    const key = String(chatId);
    const prev = state.chats[key];
    if (prev && prev.lastSeenId >= messageId) return;
    state.chats[key] = { lastSeenId: messageId, lastSeenTs: at };
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** 真正落盘：原子写（tmp + rename），串行化避免并发写坏。 */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const body = JSON.stringify(this.prune(this.read()), null, 2);
    this.chain = this.chain
      .then(async () => {
        ensureDir(this.paths.dir);
        await this.write(this.paths.state, body);
      })
      .catch(() => undefined);
    await this.chain;
  }

  /** 停机前调用：清定时器并把没落盘的写出去。 */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** 丢掉太久没动的游标，并保证总数不超过上限。 */
  private prune(state: RunState): RunState {
    const at = this.now();
    const entries = Object.entries(state.chats)
      .filter(([, cursor]) => cursor.lastSeenTs <= 0 || at - cursor.lastSeenTs <= this.keepMs)
      .sort((a, b) => b[1].lastSeenTs - a[1].lastSeenTs)
      .slice(0, this.maxChats);
    const chats: Record<string, ChatCursor> = {};
    for (const [key, cursor] of entries) chats[key] = cursor;
    if (this.cache) this.cache = { chats };
    return { chats };
  }

  cursor(chatId: number): ChatCursor | undefined {
    return this.read().chats[String(chatId)];
  }
}

/**
 * 双开保护。
 *
 * 同一份 session 被两个连接同时使用 → Telegram 判 `AUTH_KEY_DUPLICATED` 并作废该 key，
 */
export interface InstanceLockOptions {
  /** 心跳间隔（默认 30 秒）。 */
  heartbeatMs?: number;
  /** 超过这么久没心跳就算陈旧锁（默认 90 秒 = 3 个心跳）。 */
  staleMs?: number;
  now?: () => number;
}

interface LockFileBody {
  pid: number;
  since: number;
  /** 最近一次心跳时间戳；老版本写的锁没有这个字段。 */
  beat?: number;
  /** 进程随机标记：用来区分"pid 被系统复用给了别的程序"。 */
  token?: string;
}

export class InstanceLock {
  private held = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(private readonly paths: TelegramPaths, opts: InstanceLockOptions = {}) {
    this.heartbeatMs = Math.max(200, opts.heartbeatMs ?? 30_000);
    this.staleMs = Math.max(this.heartbeatMs * 2, opts.staleMs ?? 90_000);
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 尝试加锁。返回 null = 成功；否则返回占用者描述（pid/时间）。
   *
   * 用 `flag: 'wx'` **原子创建**：以前是"先 exists 再写"，两个进程同时启动时
   * 都会通过检查，双双认为自己拿到了锁——而双开的后果是 Telegram 作废授权。
   */
  acquire(): { pid: number; since: number; stale?: boolean } | null {
    ensureDir(this.paths.dir);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(this.paths.lock, JSON.stringify(this.body()), { encoding: 'utf8', flag: 'wx' });
        this.held = true;
        this.startHeartbeat();
        return null;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'EEXIST') throw error;
        const holder = this.readLock();
        // 陈旧锁（进程没了 / 心跳停了 / 内容坏了）→ 删掉重试一次
        if (!holder || this.isStale(holder)) {
          removeFile(this.paths.lock);
          continue;
        }
        return { pid: holder.pid, since: holder.since };
      }
    }
    // 两次都被抢：把最后看到的占用者报上去
    const holder = this.readLock();
    return holder
      ? { pid: holder.pid, since: holder.since }
      : { pid: 0, since: 0 };
  }

  release(): void {
    this.stopHeartbeat();
    if (!this.held) return;
    try {
      // 只删自己的锁：别把别人刚抢到的锁删了
      const holder = this.readLock();
      if (!holder || holder.token === this.token || holder.pid === process.pid) {
        removeFile(this.paths.lock);
      }
    } finally {
      this.held = false;
    }
  }

  /** 心跳：让别的进程知道"我还活着"，避免 PID 复用被误判。 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      try {
        const holder = this.readLock();
        if (holder && holder.token && holder.token !== this.token) {
          // 锁被别人拿走了（我们被自己判定为陈旧）：停掉心跳，别跟人抢
          this.stopHeartbeat();
          return;
        }
        writeFileSync(this.paths.lock, JSON.stringify(this.body()), 'utf8');
      } catch {
        // 心跳失败不致命，下一轮再试
      }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private body(): LockFileBody {
    const at = this.now();
    return { pid: process.pid, since: this.sinceAt ?? at, beat: at, token: this.token };
  }

  private sinceAt?: number;

  private readLock(): LockFileBody | null {
    try {
      const raw = JSON.parse(readFileSync(this.paths.lock, 'utf8')) as LockFileBody;
      const pid = Number(raw.pid) || 0;
      if (pid <= 0) return null;
      if (this.sinceAt === undefined && pid === process.pid) this.sinceAt = Number(raw.since) || this.now();
      return {
        pid,
        since: Number(raw.since) || 0,
        beat: raw.beat === undefined ? undefined : Number(raw.beat) || 0,
        token: typeof raw.token === 'string' ? raw.token : undefined,
      };
    } catch {
      return null;
    }
  }

  /** 陈旧判定：进程不在了，或者心跳太久没更新（PID 被复用给了别的程序）。 */
  private isStale(holder: LockFileBody): boolean {
    if (holder.pid === process.pid && this.held) return false;
    if (!isAlive(holder.pid)) return true;
    if (holder.pid === process.pid) return false;
    const beat = holder.beat ?? holder.since;
    if (!beat) return true;
    return this.now() - beat > this.staleMs;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程在，但没有信号权限
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
