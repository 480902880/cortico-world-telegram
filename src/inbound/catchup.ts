/**
 * 断线补课（消息级）。
 *
 * 严格说清楚它是什么（PLAN §13.3）：
 *  - `updates.getDifference` 是**库内部**做的权威增量恢复，覆盖编辑/删除/已读/成员变更等；
 *  - 这里做的是**消息级补偿**：重连后按 `lastSeenId` 拉最近的历史，把漏掉的消息补进来。
 *    它**不是**完整更新恢复——补不到 other_updates，所以事件里带 `recovery: message-history`。
 */

import type { Msg } from '../mtproto/port.ts';

export interface CatchUpOptions {
  /** 这个会话已处理到的最大 message id；0/undefined = 从没有过。 */
  lastSeenId?: number;
  now?: number;
  /** 只补这个时间窗内的消息（默认 24 小时）。 */
  maxAgeMs?: number;
  /** 单次最多补多少条（默认 200，防重连风暴）。 */
  limit?: number;
}

export const CATCH_UP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CATCH_UP_MAX_MESSAGES = 200;

/** 运行中补课间隔：10 分钟。太密会白拉历史，太疏补不回来。 */
export const GAP_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 运行中补课要不要跑（纯函数，方便单测）。
 * 条件：开启补课 + 距上次那次超过间隔。
 */
export function shouldRunGapCheck(lastRunAt: number, now = Date.now(), intervalMs = GAP_CHECK_INTERVAL_MS): boolean {
  if (!Number.isFinite(lastRunAt) || lastRunAt <= 0) return true;
  return now - lastRunAt >= intervalMs;
}

/**
 * 从一次 history 结果里挑出「该补的」消息：比 lastSeenId 新、在时间窗内、按 id 升序。
 * 纯函数，方便单测。
 */
export function selectFreshMessages(messages: readonly Msg[], opts: CatchUpOptions = {}): Msg[] {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? CATCH_UP_MAX_AGE_MS;
  const limit = Math.max(1, opts.limit ?? CATCH_UP_MAX_MESSAGES);
  const lastSeen = opts.lastSeenId ?? 0;

  return messages
    .filter((msg) => Number.isFinite(msg.id) && msg.id > lastSeen)
    .filter((msg) => {
      const at = msg.date > 0 ? msg.date * 1000 : now;
      return now - at <= maxAge;
    })
    .slice()
    .sort((a, b) => a.id - b.id)
    .slice(0, limit);
}
