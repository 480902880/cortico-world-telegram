/**
 * 消息合并窗口。
 *
 * 对方连发 5 条时，不该唤醒模型 5 次。这里在**投递前**做一层缓冲：
 *  - 第一条到达后开一个 `windowMs` 的定时器
 *  - 期间同一会话的消息攒在一起
 *  - 到点 / 攒满 `maxItems` / 从第一条起超过 `maxAgeMs` → 打包成一条事件
 *
 * 纯逻辑放这里，方便单测；真正的定时器在 World 里。
 */

export interface MergePolicy {
  windowMs: number;
  maxAgeMs: number;
  maxItems: number;
}

/** 攒到这个量就该立刻 flush（不等定时器）。 */
export function shouldFlush(count: number, firstAt: number, now: number, policy: MergePolicy): boolean {
  if (count <= 0) return false;
  if (policy.maxItems > 0 && count >= policy.maxItems) return true;
  if (policy.maxAgeMs > 0 && now - firstAt >= policy.maxAgeMs) return true;
  return false;
}

/** 需不需要进缓冲（窗口 0 或只允许 1 条时直接投递）。 */
export function shouldBuffer(policy: MergePolicy): boolean {
  return policy.windowMs > 0 && policy.maxItems !== 1;
}

/**
 * 合并后的正文：每条一行，按到达顺序。
 * 不加工内容——渲染已经带了发送者前缀，这里只负责拼接。
 */
export function composeMergedText(lines: readonly string[]): string {
  return lines.filter(Boolean).join('\n');
}

/** 合并事件的 meta：以最后一条为基准，补上范围信息。 */
export function composeMergedMeta(
  base: Record<string, unknown>,
  ids: readonly number[],
  count: number,
): Record<string, unknown> {
  if (count <= 1) return base;
  return {
    ...base,
    merged: count,
    message_ids: [...ids],
    first_message_id: ids[0],
    last_message_id: ids[ids.length - 1],
  };
}
