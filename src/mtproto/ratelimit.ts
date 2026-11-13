/**
 * 发送限流与 FloodWait。
 *
 * 两个不同的东西，别混：
 *  - **限流**（我们主动做的）：自己排队，每会话最短间隔 + 每分钟全局上限，别去撞 Telegram。
 *  - **FloodWait**（被动的）：Telegram 已经不高兴了，返回 `FLOOD_WAIT_X`。短的就等一次再重试，
 *    长的直接如实报错——不要在后台闷头等十分钟，那期间用户以为消息发出去了。
 */

/** 从 RPC 错误里取 `FLOOD_WAIT_X` 的秒数；不是限流错误返回 null。 */
export function floodWaitSeconds(message: string): number | null {
  const match = /FLOOD_WAIT_(\d+)/i.exec(message);
  if (!match?.[1]) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** 超过这个秒数就不自动等，直接报错（默认 60 秒）。 */
export const FLOOD_RETRY_MAX_SECONDS = 60;

export interface RateLimitOptions {
  /** 同一会话两条消息之间的最小间隔。 */
  perChatMs?: number;
  /** 每分钟全局上限。 */
  globalPerMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly lastByChat = new Map<number, number>();
  /** 最近一分钟内的发送时刻，升序。 */
  private readonly recent: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: RateLimitOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** 还要等多少毫秒（不睡）。 */
  waitFor(chatId: number, now = this.now()): number {
    const perChat = this.opts.perChatMs ?? 1000;
    const perMinute = this.opts.globalPerMinute ?? 20;

    const last = this.lastByChat.get(chatId);
    const chatWait = last === undefined ? 0 : Math.max(0, last + perChat - now);

    const windowStart = now - 60_000;
    while (this.recent.length > 0 && this.recent[0]! < windowStart) this.recent.shift();
    const globalWait = this.recent.length >= perMinute
      ? Math.max(0, this.recent[0]! + 60_000 - now)
      : 0;

    return Math.max(chatWait, globalWait);
  }

  /** 等到允许为止，然后记账。发送前必须调用。 */
  async acquire(chatId: number): Promise<void> {
    const wait = this.waitFor(chatId);
    if (wait > 0) await this.sleep(wait);
    const at = this.now();
    this.lastByChat.set(chatId, at);
    this.recent.push(at);
  }

  reset(): void {
    this.lastByChat.clear();
    this.recent.length = 0;
  }

  stats(): { chats: number; lastMinute: number } {
    return { chats: this.lastByChat.size, lastMinute: this.recent.length };
  }
}
