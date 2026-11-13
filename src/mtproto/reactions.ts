/**
 * 反应更新的解析（纯函数，便于测试）。
 *
 * Telegram 把"有人点了表情"放在独立的 update 里，字段还都很"可选"：
 *  - `UpdateMessageReactions`：某条消息的反应集合变了
 *  - `UpdateBotMessageReaction`：只发给 bot 账号（普通账号收不到）
 *
 * 这里只做"把原始 update 变成我们能用的形状"，解析不出来就返回 null（静默忽略）。
 */

import type { ChatKind, ReactionUpdate } from './port.ts';

export interface RawReactionUpdate {
  className?: string;
  peer?: unknown;
  msgId?: unknown;
  messageId?: unknown;
  reactions?: { results?: Array<{ reaction?: { emoticon?: unknown; documentId?: unknown }; count?: unknown }> };
  recentReactions?: Array<{ userId?: unknown; reaction?: unknown[] }>;
}

/** 把 peer 解析成 { id, kind }；由调用方注入（复用 client 里已有的规则）。 */
export type PeerResolver = (peer: unknown) => { id: number; kind: ChatKind };

export function parseReactionUpdate(raw: RawReactionUpdate, resolvePeer: PeerResolver): ReactionUpdate | null {
  const className = String(raw?.className ?? '');
  if (className !== 'UpdateMessageReactions' && className !== 'UpdateBotMessageReaction') return null;

  const messageId = Number(raw?.msgId ?? raw?.messageId ?? 0);
  if (!Number.isFinite(messageId) || messageId <= 0) return null;

  let chat: { id: number; kind: ChatKind };
  try {
    chat = resolvePeer(raw?.peer);
  } catch {
    return null;
  }
  if (!chat || !Number.isFinite(chat.id) || chat.id === 0) return null;

  const results = Array.isArray(raw?.reactions?.results) ? raw!.reactions!.results! : [];
  const emoticons: string[] = [];
  for (const item of results) {
    const emoji = String(item?.reaction?.emoticon ?? '').trim();
    if (emoji) emoticons.push(emoji);
    else if (item?.reaction?.documentId) emoticons.push('自定义表情');
  }

  const recent = Array.isArray(raw?.recentReactions) ? raw!.recentReactions! : [];
  const last = recent.length ? recent[recent.length - 1] : undefined;
  const userId = last?.userId ? Number(last.userId) : undefined;
  // 集合空了 = 所有反应都被取消
  const removed = results.length === 0;

  return {
    chatId: chat.id,
    chatKind: chat.kind,
    messageId,
    ...(userId ? { userId } : {}),
    emoticons: [...new Set(emoticons)],
    removed,
  };
}
