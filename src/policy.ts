/**
 * 按会话类型的权限策略（不依赖"谁是主人"——那由 Coo 自己判断）。
 *
 * 规则（使用者原话）：
 *  - 白名单**私聊真人**：正常聊天；表情包 / GIF / 贴纸 / 语音 / 翻唱随便发；
 *    但「文件类」和「个人真实信息相关」的东西要走配置：允许 / 询问主人 / 不允许。
 *    允许只是「不拦」，不是「必须做」——做不做由 bot 自己按意愿判断。
 *  - 白名单**群聊 / 频道**：只能正常交流 + 表情包 / GIF / 贴纸 / 语音；文件类一律禁止。
 *  - 白名单**TG 机器人账号**（功能性 bot）：同上，只能交流与发表情语音。
 *  - 白名单之外的一切：不接收、不唤醒（由监听白名单在更早的一层拦掉）。
 *
 * 这里只做纯判定，审批流程（发 `!ok` 码）由 World 负责。
 */

export type ChatKind = 'user' | 'group' | 'channel';

/** 一次操作的性质。 */
export type ActionKind =
  /** 文字、回复、编辑自己的消息 */
  | 'text'
  /** 表情包 / 贴纸（Telegram 包或本地表情素材） */
  | 'sticker'
  /** GIF 动图（@gif 内联结果） */
  | 'gif'
  /** 语音条 */
  | 'voice'
  /** 唱歌 / 翻唱（RVC 等产物）——算表演，不算外发文件 */
  | 'song'
  /** 文件 / 图片 / 视频 / 相册 —— 可能带个人信息的那一类 */
  | 'file'
  /** 有副作用的账号操作：删除、转发、拉黑、改联系人、装卸贴纸包、置顶、归档、静音 */
  | 'danger';

export type Verdict = 'allow' | 'ask' | 'deny';

/** 文件类的策略配置：允许 / 询问 / 不允许。允许不等于必须做。 */
export type FilePolicy = 'auto' | 'ask' | 'deny';

export interface PolicyInput {
  chatKind: ChatKind;
  /** 对方是不是 TG 官方的机器人账号（功能性 bot）。 */
  isBot: boolean;
  action: ActionKind;
  /** 白名单私聊里"文件类"的策略。 */
  filePolicy: FilePolicy;
}

export interface PolicyResult {
  verdict: Verdict;
  /** 被拒时给模型看的一句话（不要回显内部规则细节）。 */
  reason?: string;
}

/**
 * 判定一次操作。
 *
 * 群 / 频道 / bot 账号是"受限会话"：只有交流与表情语音，文件与危险操作全部拒绝。
 * 私聊真人则按 `filePolicy` 处理文件，危险操作交给既有 guard 配置（这里返回 allow）。
 */
export function decidePolicy(input: PolicyInput): PolicyResult {
  const { chatKind, isBot, action, filePolicy } = input;
  const restricted = chatKind === 'group' || chatKind === 'channel' || isBot;

  if (restricted) {
    if (action === 'text' || action === 'sticker' || action === 'gif' || action === 'voice' || action === 'song') {
      return { verdict: 'allow' };
    }
    if (action === 'file') {
      return {
        verdict: 'deny',
        reason: '这里只能正常聊天和发表情 / 语音；发送文件与图片不行',
      };
    }
    return { verdict: 'deny', reason: '这里只能正常交流，不能做这类操作' };
  }

  // 私聊真人
  if (action !== 'file') return { verdict: 'allow' };

  switch (filePolicy) {
    case 'auto':
      return { verdict: 'allow' };
    case 'deny':
      return { verdict: 'deny', reason: '文件发送已被主人设为禁止' };
    case 'ask':
    default:
      return { verdict: 'ask' };
  }
}

/** 本地表情文件的"性质"：静态/动态贴纸算 sticker，gif 算 gif，jpg 算图片（= file）。 */
export function actionForLocalSticker(form: 'sticker' | 'gif' | 'photo'): ActionKind {
  if (form === 'sticker') return 'sticker';
  if (form === 'gif') return 'gif';
  return 'file';
}
