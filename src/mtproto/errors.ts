/**
 * S-10：致命错误分类。
 *
 * 目的：把"再试也没用、越试越糟"的错误单独分出来，让上层**立刻停手**：
 *  - 会话被终止 / 账号被封 → 停止重连，等用户处理
 *  - 同一 session 被两处使用 → 停止，提示不要双开（继续重连会让 Telegram 作废授权）
 *  - PEER_FLOOD（被判定为骚扰）→ 暂停主动联系陌生人 24 小时
 *
 * 纯函数，方便用假错误写单测；真正的停机由 World / Client 执行。
 */

export type FatalKind = 'revoked' | 'banned' | 'duplicated' | 'peer-flood';

export interface FatalInfo {
  kind: FatalKind;
  /** 给用户看的一句话。 */
  human: string;
  /** 是否应该彻底停掉连接（不复重连）。 */
  stop: boolean;
}

const PATTERNS: Array<{ test: RegExp; kind: FatalKind }> = [
  // 会话没了：被别处终止 / 过期 / 从设备列表移除
  { test: /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|AUTH_KEY_INVALID/, kind: 'revoked' },
  // 账号级封禁 / 注销
  { test: /USER_DEACTIVATED_BAN|USER_DEACTIVATED|PHONE_NUMBER_BANNED|PHONE_NUMBER_INVALID/, kind: 'banned' },
  // 同一个 authKey 被两处使用
  { test: /AUTH_KEY_DUPLICATED/, kind: 'duplicated' },
  // 被判定为骚扰（多发于主动联系陌生人）
  { test: /PEER_FLOOD/, kind: 'peer-flood' },
];

/** 识别致命错误；不是致命错误返回 null（交由重试逻辑处理）。 */
export function classifyFatal(message: string): FatalInfo | null {
  const m = (message ?? '').toUpperCase();
  if (!m) return null;
  for (const { test, kind } of PATTERNS) {
    if (!test.test(m)) continue;
    switch (kind) {
      case 'revoked':
        return {
          kind,
          human: '会话已被终止（在其它设备退出，或授权被移除）：请重新登录',
          stop: true,
        };
      case 'banned':
        return {
          kind,
          human: '账号已被 Telegram 停用或封禁：插件不会继续重试，请先在官方客户端确认账号状态',
          stop: true,
        };
      case 'duplicated':
        return {
          kind,
          human: '同一条登录态被两处同时使用（多半是双开了）：请只保留一个 Coopanion 在跑，然后重新登录',
          stop: true,
        };
      case 'peer-flood':
        return {
          kind,
          human: 'Telegram 判定为骚扰行为（PEER_FLOOD）：已暂停主动联系陌生人 24 小时',
          stop: false,
        };
    }
  }
  return null;
}

export const PEER_FLOOD_PAUSE_MS = 24 * 60 * 60 * 1000;

/** 被 PEER_FLOOD 罚站期间，是否允许给某个会话发消息（白名单内不受限）。 */
export function peerFloodAllows(opts: {
  until: number;
  now?: number;
  allowlisted: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const now = opts.now ?? Date.now();
  if (opts.allowlisted) return { ok: true };
  if (!Number.isFinite(opts.until) || opts.until <= now) return { ok: true };
  const minutes = Math.max(1, Math.round((opts.until - now) / 60_000));
  return { ok: false, reason: `被 Telegram 判定骚扰，${minutes} 分钟内不再主动联系陌生人` };
}
