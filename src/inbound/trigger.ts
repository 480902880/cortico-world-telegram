/**
 * S-04：群里什么情况才该唤醒模型。
 *
 * 现状问题：白名单里的群，任何一条消息都唤醒模型——几百人的群一天能把 token 烧光。
 *
 * 规则（可配置 `groupTrigger`）：
 *  - `mention`          ：只要被 @
 *  - `mention_or_reply` ：被 @ 或回复它的消息（默认）
 *  - `allowed_senders`  ：只认白名单私聊用户说的话
 *  - `all`              ：群里每条都唤醒（老行为）
 *
 * 不满足条件的消息仍然会入库（`deliver: false`），只是不叫模型——上下文还在，只是不花钱。
 */

export type GroupTriggerMode = 'mention' | 'mention_or_reply' | 'allowed_senders' | 'all';

export interface GroupTriggerInput {
  mode: GroupTriggerMode;
  /** 消息里是否 @ 了本账号（按 entity 或用户名判断）。 */
  mentionsMe: boolean;
  /** 是否回复了本账号发过的消息。 */
  repliesToMe: boolean;
  /** 发送者是否属于白名单私聊用户。 */
  senderAllowlisted: boolean;
}

export const DEFAULT_GROUP_TRIGGER: GroupTriggerMode = 'mention_or_reply';

/** 群里这条消息该不该唤醒模型。 */
export function shouldWakeForGroup(input: GroupTriggerInput): boolean {
  const { mode, mentionsMe, repliesToMe, senderAllowlisted } = input;

  if (mode === 'all') return true;
  if (mode === 'allowed_senders') return senderAllowlisted;
  if (mentionsMe) return true;
  if (mode === 'mention') return false;
  return repliesToMe;
}