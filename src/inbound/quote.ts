/**
 * 引用（回复）标记的格式化。
 *
 * 以前只给编号：`(回复 #327)` —— 模型只能看到"有个人在回一条编号 327 的消息"，
 * 完全不知道被引用的内容，于是只能反问"你引用的是哪条"。
 *
 * 现在把正文一起带上：`(回复 #327 「某人: 原话…」)`。
 * 太长就截断，宁可少一点也别把上下文塞爆。
 */

export const QUOTE_MAX_CHARS = 120;

/** 把被引用消息的正文压成一行，超长截断。 */
export function compactQuote(text: string, max = QUOTE_MAX_CHARS): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** 生成引用标记；没有正文时退回老格式（只有编号）。 */
export function formatQuoteMark(messageId: number, quote?: string): string {
  const body = compactQuote(quote ?? '');
  return body ? `(回复 #${messageId} 「${body}」)` : `(回复 #${messageId})`;
}
