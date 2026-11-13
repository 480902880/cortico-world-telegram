/**
 * MTProto 端口：业务层**唯一**依赖的抽象。
 *
 * 硬规则（PLAN §13.1）：
 *  - 本文件只出现我们自己的领域类型，**不出现任何 `Api.*`**。
 *  - `teleproto` / `telegram` 的原始对象只允许出现在 `impl/` 里；`Msg.raw` 是唯一例外，
 *    它仅供 impl 内部回查，业务层禁止读取。
 *  - 只支持 teleproto（GramJS 已归档）；换库要改的是 `lib.ts` 一个文件。
 *
 * 实现进度（P0）：
 *  ✔ state / connect / disconnect / me / sendCode / signIn / checkPassword / saveSession /
 *    logOut / onUpdates / lastSync / history / sendText
 *  ✘ 其余方法先签名，实现体统一 `throw new UnsupportedError(阶段, 能力)`，
 *    由工具层翻译成「该功能尚未实现」，绝不返回假成功。
 */

export type ChatKind = 'user' | 'group' | 'channel';

export interface ChatRef {
  /** Telegram 的 chat/user id。supergroup 与 channel 为负数（-100…）。 */
  id: number;
  kind: ChatKind;
  title?: string;
  /** 对方是否 TG 机器人账号（功能性 bot）。按需探测后带出。 */
  bot?: boolean;
}

export type MediaKind =
  | 'photo' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'gif' | 'other';

export interface MediaInfo {
  kind: MediaKind;
  mime?: string;
  size?: number;
  fileName?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  /** 贴纸的表情（DocumentAttributeSticker.alt）。 */
  emoji?: string;
  /** 音频的「艺人 - 标题」。 */
  title?: string;
}

/** 一条消息的领域视图。`id` 只在 `chatId` 内唯一——索引键必须是 (chatId, id)。 */
export interface Msg {
  chatId: number;
  chatKind: ChatKind;
  id: number;
  /** unix 秒。 */
  date: number;
  text: string;
  senderId?: number;
  senderName?: string;
  /** 账号自己发出（**包括** Desktop/手机发的）。 */
  out: boolean;
  /** 由本插件这条连接发出——由 sentIds/updateMessageID 判定后回填。 */
  viaClient?: boolean;
  replyToId?: number;
  /** 论坛话题 id（= 该话题的顶层消息 id）。 */
  topicId?: number;
  media?: MediaInfo;
  edited?: boolean;
  /** 群里这条消息是否 @ 了本账号（按 entity 判定）。 */
  mentionsMe?: boolean;
  /** 转发来源（人名/频道名）；本账号自己转的、无来源则不给。 */
  forwardedFrom?: string;
  /** 收到时这条消息上已有的表情反应（带次数）。 */
  reactions?: Array<{ emoji: string; count: number }>;
}

export interface AccountInfo {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface SentRef {
  chatId: number;
  messageId: number;
  /** 本次发送用的 random_id，用于与 updateMessageID 对齐（PLAN §13.4）。 */
  randomId: bigint;
  date: number;
}

export interface SendTextOptions {
  replyToId?: number;
  topicId?: number;
  silent?: boolean;
  /** 关掉链接预览（默认开）。 */
  linkPreview?: boolean;
}

export interface HistoryOptions {
  limit?: number;
  /** 取该 id 之前（更旧）的消息。 */
  beforeId?: number;
  topicId?: number;
}

/** 连接状态。`revoked` = 会话被其他设备终止，必须停机提示重登（PLAN §12.3）。 */
export interface ConnectionState {
  status: 'offline' | 'connecting' | 'online' | 'error' | 'revoked' | 'banned';
  /** 进入该状态的 unix 毫秒。 */
  since: number;
  detail?: string;
}

export type AuthStep =
  | 'idle'          // 未登录
  | 'code_sent'     // 验证码已发
  | 'password_needed' // 需要两步验证密码
  | 'authorized'
  | 'error'
  | 'revoked';

export interface AuthStatus {
  step: AuthStep;
  /** 形如 +86 138****8888，绝不回明文。 */
  phoneMasked?: string;
  account?: AccountInfo;
  detail?: string;
}

/** 更新回调。所有字段都是领域类型。 */
export interface UpdateHandlers {
  onMessage(m: Msg): void;
  onEditMessage?(m: Msg): void;
  onDelete?(chat: ChatRef, ids: number[]): void;
  /**
   * 本连接发出的消息拿到了服务端 id。
   * 这是「认出自己发的消息」的**唯一可靠通道**（message 里没有 random_id）。
   */
  onMessageId?(randomId: bigint, messageId: number): void;
  /**
   * 有人给某条消息加了/取消了表情反应。
   * 反应不是「新消息」，走的是另一类 update——不单独订阅就完全看不见。
   */
  onReaction?(info: ReactionUpdate): void;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  mime?: string;
}

export interface SendFileOptions {
  caption?: string;
  /** 当语音条发（需要 ogg/opus；其他格式只能当普通音频文件）。 */
  asVoice?: boolean;
  /** 强制按文件发，不压成图片/视频。 */
  forceDocument?: boolean;
  replyToId?: number;
}

export interface StickerSetRef {
  shortName: string;
  title: string;
  count: number;
}

export interface StickerInfo {
  id: bigint;
  accessHash: bigint;
  fileReference: Uint8Array;
  emoji?: string;
  mime: string;
}

export interface StickerSetInfo extends StickerSetRef {
  stickers: StickerInfo[];
}

export interface UserInfo {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  /** 仅联系人可见。 */
  phone?: string;
  bio?: string;
  bot?: boolean;
  /** 和这个人的共同群数量（`users.GetFullUser` 报的）。 */
  commonChatsCount?: number;
}

export interface DialogEntry {
  chat: ChatRef;
  /** @username（有的话），方便人确认这是谁。 */
  username?: string;
  /** 最后一条消息的 id 与时间；空会话为 0。 */
  lastMessageId: number;
  lastDate: number;
  unread: number;
  /** 是不是 Bot（Bot 默认不唤醒）。 */
  bot?: boolean;
}

export interface TopicInfo {
  id: number;
  title: string;
  closed: boolean;
  pinned: boolean;
}

/** 群成员/频道订阅者的一条。 */
export interface MemberInfo {
  id: number;
  name: string;
  username?: string;
  bot?: boolean;
  /** 管理员或群主。 */
  admin?: boolean;
}

export interface ChatInfo extends ChatRef {
  username?: string;
  about?: string;
  membersCount?: number;
  isForum?: boolean;
}

/** 按名字/用户名搜出来的候选会话。 */
export interface PeerCandidate {
  id: number;
  kind: ChatKind;
  title: string;
  username?: string;
  bot?: boolean;
}


/** 一条消息反应里的单人记录。 */
/** 收到的一次反应变化（增量，不是全量列表）。 */
export interface ReactionUpdate {
  chatId: number;
  chatKind: ChatKind;
  messageId: number;
  /** 谁点的；匿名/频道可能是 undefined。 */
  userId?: number;
  userName?: string;
  /** 这次变化的 emoji；取消反应时是空数组。 */
  emoticons: string[];
  /** 取消（true）还是新增（false）。 */
  removed: boolean;
}

export interface ReactionEntry {
  emoji: string;
  userId: number;
  name?: string;
}

/** 聊天文件夹（DialogFilter）。 */
export interface FolderInfo {
  id: number;
  title: string;
}

/** 一条 GIF 搜索结果（来自 @gif 内联机器人）。 */
export interface GifResult {
  index: number;
  title: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
}

/** 更新通道的同步质量，用于面板区分「权威增量」与「消息级补偿」（PLAN §13.3）。 */
export interface SyncQuality {
  /** 库报告的 pts；未知则空。 */
  pts?: number;
  /** true = 库内部的 updates.getDifference 已对齐（权威）；false = 只有我们的消息级 catch-up。 */
  authoritative: boolean;
}

/** 未实现的能力。工具层据此回「尚未实现」，不得伪造成功。 */
export class UnsupportedError extends Error {
  constructor(readonly stage: string, readonly feature: string) {
    super(`${feature} 尚未实现（计划阶段 ${stage}）`);
    this.name = 'UnsupportedError';
  }
}

export interface MtprotoPort {
  // ── 连接 ──────────────────────────────────────────────
  state(): ConnectionState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** 库内部的 update state 是否已由 getDifference 对齐。 */
  syncQuality(): SyncQuality;

  // ── 账号 / 登录 ───────────────────────────────────────
  me(): Promise<AccountInfo>;
  sendCode(phone: string): Promise<{ codeHash: string; viaApp: boolean }>;
  signIn(phone: string, codeHash: string, code: string): Promise<'ok' | 'password-needed'>;
  checkPassword(password: string): Promise<void>;
  /** 导出本客户端 session 串（StringSession）。 */
  saveSession(): string;
  /** 只注销**本条**授权（auth.logOut）+ 本地清空；绝不 resetAuthorizations。 */
  logOut(): Promise<void>;

  // ── 更新 ──────────────────────────────────────────────
  onUpdates(handlers: UpdateHandlers): () => void;

  // ── 读（P0 只实现 history）───────────────────────────
  history(chat: ChatRef, opts?: HistoryOptions): Promise<Msg[]>;

  // ── 写（P0 只实现 sendText）──────────────────────────
  sendText(chat: ChatRef, text: string, opts?: SendTextOptions): Promise<SentRef>;

  // ── 以下按阶段实现，P0 一律 UnsupportedError ─────────
  dialogs(limit?: number): Promise<DialogEntry[]>;
  /** 按名字 / 用户名 / id / t.me 链接搜会话，返回候选（可能多个）。 */
  searchPeers(query: string): Promise<PeerCandidate[]>;
  /** 只按 @username 或 t.me 链接解析；解析不到返回 null。 */
  resolveUsername(raw: string): Promise<PeerCandidate | null>;
  /** 单条消息（含媒体信息）。 */
  getMessage(chat: ChatRef, messageId: number): Promise<Msg | null>;
  chatInfo(chat: ChatRef): Promise<ChatInfo>;
  topics(chat: ChatRef): Promise<TopicInfo[]>;
  /**
   * 群成员 / 频道订阅者。
   * `adminsOnly` 只列管理员，`query` 按名字搜——两者互斥，query 优先。
   */
  participants(
    chat: ChatRef,
    opts?: { limit?: number; offset?: number; adminsOnly?: boolean; query?: string },
  ): Promise<MemberInfo[]>;
  search(chat: ChatRef, query: string, limit?: number): Promise<Msg[]>;
  editText(chat: ChatRef, messageId: number, text: string): Promise<void>;
  deleteMessages(chat: ChatRef, ids: number[], revoke: boolean): Promise<number>;
  forward(from: ChatRef, ids: number[], to: ChatRef): Promise<SentRef[]>;
  react(chat: ChatRef, messageId: number, emoji: string): Promise<void>;
  markRead(chat: ChatRef, upToId: number): Promise<void>;
  download(chat: ChatRef, messageId: number, destDir: string): Promise<DownloadResult>;
  /**
   * 取一条消息里的图片字节（给事件附带用）。
   * 不是图片、超过 maxBytes、或下载失败都返回 null——调用方照常投递文本，不因为图挂了丢消息。
   */
  fetchImage(chat: ChatRef, messageId: number, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
  /**
   * 取消息附件的缩略图（视频预览帧 / 照片小图）。
   * 只下缩略图，不下整个视频——模型能看一眼就够。
   */
  fetchThumbnail(chat: ChatRef, messageId: number): Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
  sendFile(chat: ChatRef, filePath: string, opts?: SendFileOptions): Promise<SentRef>;
  /** 一次发多张图（相册，2–10 个）。 */
  sendAlbum(chat: ChatRef, filePaths: string[], caption?: string): Promise<SentRef[]>;
  searchStickerSets(query: string): Promise<StickerSetRef[]>;
  stickerSet(shortName: string): Promise<StickerSetInfo>;
  sendSticker(chat: ChatRef, sticker: StickerInfo, replyToId?: number): Promise<SentRef>;
  /**
   * 把**本地**表情文件当表情发出去（png/webp/tgs/webm）。
   * 不是当图片或文件发——会带上 sticker 属性，Telegram 里显示为表情。
   */
  sendLocalSticker(
    chat: ChatRef,
    filePath: string,
    opts?: { emoji?: string; replyToId?: number },
  ): Promise<SentRef>;
  /** 收藏 / 取消收藏单个贴纸。 */
  faveSticker(sticker: StickerInfo, unfave?: boolean): Promise<void>;
  /** 已收藏的贴纸（账号级）。 */
  favedStickers(): Promise<StickerInfo[]>;
  installStickerSet(shortName: string, archived?: boolean): Promise<void>;
  uninstallStickerSet(shortName: string): Promise<void>;
  /** 已安装的贴纸包。 */
  installedStickerSets(): Promise<StickerSetRef[]>;
  /**
   * GIF 搜索（走内联机器人 @gif，就是你截图里那个面板）。
   * 与贴纸包搜索不同：这条链支持中文。
   */
  searchGifs(query: string): Promise<GifResult[]>;
  /** 把搜到的第 index 个 GIF 发出去（当动图文档发，不是当文件）。 */
  sendGif(chat: ChatRef, query: string, index?: number): Promise<SentRef & { title?: string }>;
  /** 置顶 / 取消置顶一条消息（私聊也能置顶，会对双方生效）。 */
  pinMessage(chat: ChatRef, messageId: number, pin?: boolean): Promise<void>;
  /** 归档 / 取消归档（folderId 1 = 归档）。 */
  archiveChat(chat: ChatRef, archive?: boolean): Promise<void>;
  /** 转存到 Saved Messages（本质是转发到自己的收藏夹）。 */
  saveMessage(chat: ChatRef, messageId: number): Promise<SentRef>;
  /** 一条消息上的反应明细。 */
  messageReactions(chat: ChatRef, messageId: number): Promise<ReactionEntry[]>;
  /** 聊天文件夹列表。 */
  folders(): Promise<FolderInfo[]>;
  contacts(): Promise<UserInfo[]>;
  /** 用户资料（含共同群数量）。拿不到的字段就不给，不编。 */
  userInfo(user: ChatRef): Promise<UserInfo>;
  /** 和这个人的共同群（`messages.getCommonChats`）。 */
  commonChats(user: ChatRef, limit?: number): Promise<ChatRef[]>;
  addContact(user: ChatRef, opts: { firstName: string; lastName?: string; phone?: string }): Promise<void>;
  /** 拉黑（contacts.block）：对方不能再给你发消息。 */
  blockUser(user: ChatRef): Promise<void>;
  unblockUser(user: ChatRef): Promise<void>;
  /** 已拉黑名单。 */
  blockedUsers(limit?: number): Promise<UserInfo[]>;
  /**
   * 静音会话（account.updateNotifySettings）。
   * minutes: 0 = 取消静音，-1 = 永久，>0 = 静音这么多分钟。
   * 返回实际的 muteUntil（unix 秒）。
   */
  muteChat(chat: ChatRef, minutes: number): Promise<number>;
  deleteContact(user: ChatRef): Promise<void>;
}
