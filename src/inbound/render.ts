/**
 * 把消息的「非正文信息」渲染成人能读懂的一小段。
 *
 * 目的：模型看到的应该是**消息本身**，而不是一串加工过的标记。
 * 之前只给 `[voice]`、`[document]`，于是它不知道语音多长、文件多大、贴纸是什么表情。
 */

import type { MediaInfo, Msg } from '../mtproto/port.ts';

/** 秒 → `1:05` / `1:02:03`。 */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** 字节 → `820 B` / `12.3 KB` / `1.4 MB`。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 媒体的一行描述；没有媒体返回空串。 */
export function formatMedia(media?: MediaInfo): string {
  if (!media) return '';
  const bits: string[] = [media.kind];
  if (media.emoji) bits.push(media.emoji);
  if (media.title) bits.push(media.title);
  if (media.fileName && media.fileName !== media.title) bits.push(media.fileName);
  if (media.durationSec !== undefined) bits.push(formatDuration(media.durationSec));
  if (media.size !== undefined) {
    const size = formatSize(media.size);
    if (size) bits.push(size);
  }
  if (media.width && media.height) bits.push(`${media.width}×${media.height}`);
  return `[${bits.join(' ')}]`;
}

/** 「已编辑」「转发自谁」这类附加标记，按出现顺序拼。 */
export function formatFlags(msg: Pick<Msg, 'edited' | 'forwardedFrom' | 'topicId'>): string[] {
  const flags: string[] = [];
  if (msg.forwardedFrom) flags.push(`(转发自 ${msg.forwardedFrom})`);
  if (msg.edited) flags.push('(已编辑)');
  if (msg.topicId) flags.push(`(话题 #${msg.topicId})`);
  return flags;
}

/** 消息上已有的反应：`[反应 👍2 ❤1]`；没有返回空串。 */
export function formatReactions(list?: Array<{ emoji: string; count: number }>): string {
  if (!list || !list.length) return '';
  const parts = list.slice(0, 8).map((item) => `${item.emoji}${item.count > 1 ? item.count : ''}`);
  return `[反应 ${parts.join(' ')}]`;
}