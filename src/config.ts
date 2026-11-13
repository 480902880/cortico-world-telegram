/**
 * `worlds.telegram` 配置段。
 *
 * 只有 `defaults()` 会用它；运行期一律读 `ctx.cfg`（活引用），所以改这些字段不需要重启，
 * 例外是凭据与传输：它们在构造 client 时用掉，改了要重启 World。
 */

import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { GuardPolicy } from './approval.ts';
import type { ResourceDirs } from './resources.ts';
import type { Language } from 'cortico/core/language.ts';

/** 高危操作的处置策略。 */
export interface GuardConfig {
  /** 删除消息（revoke）。 */
  deleteRevoke: GuardPolicy;
  /** 添加/删除联系人。 */
  contactWrite: GuardPolicy;
  /**
   * 拉黑。默认 `auto`——用户要 bot 自己判断；
   * 想让人拍板就改成 `ask`（主号回 !ok 码才执行）。
   */
  blockUser: GuardPolicy;
}

export interface TelegramRosterEntry {
  id: number;
  enabled: boolean;
}

export interface TelegramConfigSection {
  enabled: boolean;
  /** my.telegram.org 的 api_id；0 = 用内置/环境变量里的默认值。 */
  apiId: number;
  /** 与 apiId 成对；留空则走 .env 或内置默认。 */
  apiHash: string;
  watchPrivate: boolean;
  watchGroup: boolean;
  watchChannel: boolean;
  /**
   * 账号自己发出的消息怎么处理：
   *  - off：丢弃（连历史都不留）
   *  - record：归档但不唤醒（Bot 在历史里知道「这是你自己说的」）
   *  - echo：当外部消息投递（可能自己跟自己聊起来，慎用）
   */
  watchSelf: 'off' | 'record' | 'echo';
  /**
   * 群里什么情况才唤醒模型：
   * mention（只认 @）/ mention_or_reply（默认，@ 或回复）/ allowed_senders / all。
   */
  groupTrigger: 'mention' | 'mention_or_reply' | 'allowed_senders' | 'all';
  /** silent = 从不调用 account.updateStatus，避免影响手机/Desktop 的在线状态。 */
  presence: 'silent' | 'onlineWhileRunning';
  /** 关 = 不动 Desktop 的未读红点。 */
  autoMarkRead: boolean;
  /** 关 = 不在手机上显示「正在输入」。 */
  typingIndicator: boolean;
  /** 可选审计日志：把工具调用记到 data/telegram/audit.jsonl（默认关）。 */
  auditLog: boolean;
  /** 重连后按 lastSeenId 做有界消息补偿（消息级，非完整恢复）。 */
  catchUp: boolean;
  mergeWindowMs: number;
  mergeMaxAgeMs: number;
  mergeMaxItems: number;
  replyMode: 'direct' | 'review';
  /** 允许唤醒 Bot 的用户（私聊）。空 = 谁都不唤醒。 */
  allowUsers: TelegramRosterEntry[];
  /** 允许唤醒 Bot 的群/频道。 */
  allowChats: TelegramRosterEntry[];
  /** 高危操作策略。 */
  guard: GuardConfig;
  /** 谁有权回 !ok 批准；0 = 白名单里的第一个用户。 */
  approverUserId: number;
  /**
   * 主人的 Telegram 数字 ID（可多个）。用途是「通知与审批的收件地址」，
   * **不是**放行条件——放行要看暗号验证（`telegram_confirm_owner`）。
   */
  ownerUserIds: number[];
  /** 面板里填的单个主人 ID（`ownerUserIds` 为空时用它）。 */
  ownerUserId: number;
  /**
   * 白名单**私聊真人**要求发送「文件 / 图片 / 个人材料」时的策略。
   * uto 直接发、sk 先问主人、deny 一律拒绝。
   * 群 / 频道 / TG bot 账号不受此项影响——那些会话只能交流与发表情。
   */
  fileByWhitelisted: GuardPolicy;
  /** 审批码有效期（分钟）。 */
  approvalTtlMinutes: number;
  /** 本地资源目录。空串 = 未配置（下载/临时目录有内置缺省）。 */
  resources: ResourceDirs;
  /** 行为偏好（会写进提示词变量）。 */
  preferences: {
    autoFindLocalMedia: boolean;
    voiceSendAsVoice: boolean;
  };
  /** 超过这个体积就不把媒体字节塞进工具回执（只给路径）。 */
  maxMediaBytes: number;
  /** 语音条转码用的 ffmpeg（默认走 PATH）。 */
  ffmpegPath: string;
  /** 收到图片时自动下载并挂到事件上（模型直接能看）。 */
  autoImages: boolean;
  /** 视频/文件取缩略图挂到事件上（不下载整个视频）。 */
  autoThumbnails: boolean;
  /** 媒体缓存保留小时数；<=0 表示永久保留、不清理。 */
  mediaKeepHours: number;
  /** 发送限流：每会话最短间隔 + 每分钟全局上限。 */
  rateLimit: { perChatMs: number; globalPerMinute: number };
  /** 会话页双击展开时的默认历史条数（10–900）。 */
  panelHistoryLimit: number;
  transport: { useWSS: boolean; proxy: string };
}

export const TELEGRAM_SECRETS = {
  apiId: 'TG_API_ID',
  apiHash: 'TG_API_HASH',
} as const;

/** 每次返回新对象：World 定义要求 defaults() 不能复用引用。 */
export function telegramDefaults(): TelegramConfigSection {
  return {
    enabled: false,
    apiId: 0,
    apiHash: '',
    watchPrivate: true,
    watchGroup: false,
    watchChannel: false,
    watchSelf: 'record',
    groupTrigger: 'mention_or_reply',
    presence: 'silent',
    autoMarkRead: false,
    typingIndicator: false,
    auditLog: false,
    catchUp: true,
    mergeWindowMs: 3000,
    mergeMaxAgeMs: 8000,
    mergeMaxItems: 10,
    replyMode: 'direct',
    allowUsers: [],
    allowChats: [],
    // 默认全放开：AI 自主操作，不打扰人。
    // 想收紧就把对应项改成 'ask'（主号回 !ok 码才执行）或 'deny'（直接拒）。
    guard: {
      deleteRevoke: 'auto',
          contactWrite: 'auto',
        blockUser: 'auto',
    },
    approverUserId: 0,
    ownerUserIds: [],
    ownerUserId: 0,
    fileByWhitelisted: 'auto',
    approvalTtlMinutes: 5,
    // 空串 = 未配置；下载/临时目录在运行时回落到 data/telegram/{media,tmp}
    resources: { voice: '', song: '', image: '', video: '', file: '', sticker: '', download: '' },
    preferences: { autoFindLocalMedia: true, voiceSendAsVoice: true },
    maxMediaBytes: 8 * 1024 * 1024,
    ffmpegPath: 'ffmpeg',
    autoImages: true,
    autoThumbnails: true,
    mediaKeepHours: 72,
    rateLimit: { perChatMs: 1000, globalPerMinute: 20 },
    panelHistoryLimit: 100,
    transport: { useWSS: true, proxy: '' },
  };
}

/** 只保留启用项。 */
export function enabledIds(entries: TelegramRosterEntry[] | undefined): Set<number> {
  const out = new Set<number>();
  for (const entry of entries ?? []) {
    if (entry && entry.enabled && Number.isFinite(entry.id)) out.add(Number(entry.id));
  }
  return out;
}

/**
 * 「配置」页签里的可调项。
 *
 * 只放**热更新**字段（读的是 `ctx.cfg` 活引用）；凭据、传输要重启，放在登录面板里。
 */
export function telegramConfigGroup(language: Language): ConfigGroup {
  const zh = language === 'zh' || language === 'zh-Hant';
  return {
    id: 'world:telegram',
    owner: 'world:telegram',
    schema: {
      type: 'object',
      title: zh ? 'Telegram' : 'Telegram',
      description: zh
        ? '监听范围与合并窗口。改动立即生效；凭据与代理需要重启 World。'
        : 'Watch scope and merge window. Takes effect immediately; credentials and proxy need a restart.',
      properties: {
        'worlds.telegram.watchPrivate': {
          type: 'boolean',
          title: zh ? '监听私聊' : 'Watch private chats',
          'x-hot': true,
          description: zh ? '关闭后私聊消息直接丢弃。' : 'When off, private messages are dropped.',
        },
        'worlds.telegram.watchGroup': {
          type: 'boolean',
          title: zh ? '监听群组' : 'Watch groups',
          'x-hot': true,
          description: zh ? '仍需把群 id 加进白名单。' : 'The chat id must still be in the allow list.',
        },
        'worlds.telegram.watchChannel': {
          type: 'boolean',
          title: zh ? '监听频道' : 'Watch channels',
          'x-hot': true,
          description: zh ? '默认关闭，避免广播刷屏。' : 'Off by default to avoid channel flood.',
        },
        'worlds.telegram.mergeWindowMs': {
          type: 'integer',
          title: zh ? '消息合并窗口' : 'Merge window',
          minimum: 0,
          maximum: 15_000,
          multipleOf: 100,
          'x-suffix': 'ms',
          'x-hot': true,
          description: zh
            ? '同会话连续消息在这个窗口内合并成一条事件；0 = 逐条投递。'
            : 'Consecutive messages in one chat merge into a single event; 0 = deliver each.',
        },
        'worlds.telegram.mediaKeepHours': {
          type: 'integer',
          title: zh ? '媒体缓存保留' : 'Keep downloaded media',
          minimum: 0,
          maximum: 24 * 365,
          multipleOf: 1,
          'x-suffix': zh ? '小时' : 'h',
          'x-hot': true,
          description: zh
            ? '下载的图片/语音/视频超过这个时长自动删除；0 或留空 = 不自动清理（仍可让 bot 手动清）。'
            : 'Downloaded media older than this is deleted automatically; 0 / blank = never clean automatically.',
        },
      },
    },
  };
}
