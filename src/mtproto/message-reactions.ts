/**
 * 消息上**已有**的表情反应。
 *
 * Telegram 把 `reactions` 直接挂在 Message 上（`MessageReactions.results[]`，每项带
 * reaction + count），所以不用额外查接口——收到消息时顺手就能拿到"这条已经有 👍3 ❤1"。
 *
 * 之前完全没用这个字段，于是模型看到的是一条"没人反应过"的消息。
 */

export interface ReactionCount {
  emoji: string;
  count: number;
}

/** 从原始消息里提取反应计数；拿不到返回 undefined（不是空数组，避免噪音）。 */
export function reactionSummary(raw: any): ReactionCount[] | undefined {
  const results = raw?.reactions?.results;
  if (!Array.isArray(results) || results.length === 0) return undefined;

  const out: ReactionCount[] = [];
  for (const item of results) {
    const emoji = String(item?.reaction?.emoticon ?? '').trim();
    const count = Number(item?.count ?? 0);
    if (!emoji && !item?.reaction?.documentId) continue;
    out.push({ emoji: emoji || '自定义表情', count: count > 0 ? count : 1 });
  }
  return out.length ? out : undefined;
}
