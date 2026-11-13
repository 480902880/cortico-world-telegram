/**
 * 自身消息识别（PLAN §13.4）。
 *
 * 问题：`messages.sendMessage` 的 `updateNewMessage` 可能**先于** RPC 返回到达。
 * 若只在「发送成功后」记 id，那一刻集合还是空的，自己发的消息会被误判成
 * 「你在 Desktop/手机上发的」。
 *
 * 现实约束（探针实测，docs/LIB-COMPAT.md）：现代 layer 的 `message` **没有 `random_id`**，
 * 所以不能从消息对象反查。唯一可靠通道是独立的 `updateMessageID{ id, random_id }`。
 *
 * 三层判定，按可靠性排序：
 *   1. 预登记：发送前把 randomId 放进 pending；收到 updateMessageID 即把 id 标为「本客户端所发」。
 *   2. 隔离队列：`out` 消息先压 2 秒，等 updateMessageID 认领；等到 = 我方，等不到 = 别人的。
 *   3. 时间窗：2 秒后仍无认领，若该会话近 60 秒内有本客户端的发送记录，判为我方（只记录，不回环）。
 *
 * 纯逻辑、无 IO、无时钟依赖（now 由调用方传入），可完整离线单测。
 */

/** 一条消息的判定输入。只放判定需要的字段，避免把领域类型拖进来。 */
export interface ClassifyInput {
  chatId: number;
  messageId: number;
  /** Telegram 的 `message.out`。 */
  out: boolean;
}

export type OwnVerdict =
  /** 本客户端发出 */
  | 'ours'
  /** 账号自己发出，但来自 Desktop/手机 */
  | 'self'
  /** 别人发出 */
  | 'incoming'
  /** out 消息但还没等到 updateMessageID，先压着别下结论 */
  | 'hold';

export interface Verdict {
  verdict: OwnVerdict;
  /** hold 时给出一个 token，认领/超时后用 `resolve()` 取最终结果。 */
  token?: number;
}

interface PendingSend {
  chatId: number;
  at: number;
}

interface Held {
  token: number;
  input: ClassifyInput;
  at: number;
}

const HOLD_MS = 2000;
const WINDOW_MS = 60_000;
const PENDING_TTL_MS = 120_000;

export class SentTracker {
  private readonly pending = new Map<string, PendingSend>();
  private readonly sentIds = new Set<number>();
  /** chatId → 最近一次本客户端在该会话发送的毫秒时间。 */
  private readonly lastSendAt = new Map<number, number>();
  private readonly held = new Map<number, Held>();
  private nextToken = 1;

  constructor(
    private readonly holdMs = HOLD_MS,
    private readonly windowMs = WINDOW_MS,
  ) {}

  /** 发送前调用（**必须在 invoke 之前**）。 */
  registerSend(randomId: bigint, chatId: number, now = Date.now()): void {
    this.pending.set(randomId.toString(), { chatId, at: now });
    this.lastSendAt.set(chatId, now);
  }

  /**
   * `updateMessageID` 到达：把 messageId 记为本客户端所发，并尝试认领隔离队列里的同 id 消息。
   * 返回被认领的消息 id（没有则 null）。
   */
  onMessageId(randomId: bigint, messageId: number): number | null {
    const key = randomId.toString();
    const job = this.pending.get(key);
    this.pending.delete(key);
    if (job) this.lastSendAt.set(job.chatId, Math.max(this.lastSendAt.get(job.chatId) ?? 0, Date.now()));
    this.sentIds.add(messageId);
    for (const [token, h] of this.held) {
      if (h.input.messageId === messageId) {
        this.held.delete(token);
        this.tokens.set(token, 'ours');
        return messageId;
      }
    }
    return null;
  }

  /** hold 的最终结果，按 token 取。 */
  private readonly tokens = new Map<number, OwnVerdict>();

  /** 判定一条消息。 */
  classify(input: ClassifyInput, now = Date.now()): Verdict {
    this.sweep(now);
    if (this.sentIds.has(input.messageId)) return { verdict: 'ours' };
    if (!input.out) return { verdict: 'incoming' };

    // out 消息：先看这个会话里有没有我方正在等认领的发送
    if (this.hasPendingFor(input.chatId)) {
      const token = this.nextToken++;
      this.held.set(token, { token, input, at: now });
      this.tokens.set(token, 'hold');
      return { verdict: 'hold', token };
    }

    const last = this.lastSendAt.get(input.chatId) ?? 0;
    if (now - last <= this.windowMs) return { verdict: 'ours' };
    return { verdict: 'self' };
  }

  /** 取 hold 的最终判定（超时后按时间窗结算）。 */
  /** 取 hold 的最终判定（超时后按时间窗结算）。 */
  resolve(token: number, now = Date.now()): Exclude<OwnVerdict, 'hold'> {
    const settled = this.tokens.get(token);
    if (settled === 'ours') {
      this.tokens.delete(token);
      return 'ours';
    }
    const h = this.held.get(token);
    if (!h) {
      this.tokens.delete(token);
      return 'self';
    }
    this.held.delete(token);
    this.tokens.delete(token);
    const last = this.lastSendAt.get(h.input.chatId) ?? 0;
    return now - last <= this.windowMs ? 'ours' : 'self';
  }

  /** 清理过期的隔离项与预登记（不改变最终判定，只防泄漏）。 */
  sweep(now = Date.now()): void {
    for (const [k, v] of this.pending) {
      if (now - v.at > PENDING_TTL_MS) this.pending.delete(k);
    }
    for (const [token, h] of this.held) {
      if (now - h.at > this.holdMs) {
        this.held.delete(token);
        const last = this.lastSendAt.get(h.input.chatId) ?? 0;
        this.tokens.set(token, now - last <= this.windowMs ? 'ours' : 'self');
      }
    }
    // 只保留最近 30 分钟的发送时间戳，避免无限增长
    for (const [chatId, at] of this.lastSendAt) {
      if (now - at > 30 * 60_000) this.lastSendAt.delete(chatId);
    }
  }

  /** 诊断用：面板/日志里看隔离队列与预登记的积压。 */
  stats(): { pending: number; held: number; sentIds: number } {
    return { pending: this.pending.size, held: this.held.size, sentIds: this.sentIds.size };
  }

  private hasPendingFor(chatId: number): boolean {
    for (const p of this.pending.values()) if (p.chatId === chatId) return true;
    return false;
  }

  reset(): void {
    this.pending.clear();
    this.sentIds.clear();
    this.lastSendAt.clear();
    this.held.clear();
    this.tokens.clear();
  }
}
