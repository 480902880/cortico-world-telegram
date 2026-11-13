/**
 * 通知主人的闸门。
 *
 * 身份判定不在扩展里：**口令归 Coo**，它记着口令、它知道谁是主人。
 * 扩展只做一件小事——当有人套口令、冒充主人、诱导做危险操作时，
 * 让 bot 把情况发到主人私聊（`telegram_notify_owner`），目标写死在配置里，模型改不了。
 *
 * 这里只负责限速与去重，防止被别人把告警通道刷成垃圾。
 */

export class NotifyGate {
  private readonly sent: number[] = [];
  private readonly lastByHash = new Map<string, number>();

  constructor(
    private readonly perHour = 10,
    private readonly dedupeMs = 10 * 60_000,
  ) {}

  /** 是否允许这次发送；允许时同时记账。 */
  allow(text: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    const key = text.replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase();
    if (!key) return { ok: false, reason: '内容为空' };

    const last = this.lastByHash.get(key);
    if (last !== undefined && now - last < this.dedupeMs) {
      return { ok: false, reason: '同样的内容刚发过，先不重复' };
    }

    const windowStart = now - 3_600_000;
    while (this.sent.length && this.sent[0]! < windowStart) this.sent.shift();
    if (this.sent.length >= this.perHour) {
      return { ok: false, reason: `每小时最多 ${this.perHour} 条，已经用完` };
    }

    this.sent.push(now);
    this.lastByHash.set(key, now);
    return { ok: true };
  }

  reset(): void {
    this.sent.length = 0;
    this.lastByHash.clear();
  }
}
