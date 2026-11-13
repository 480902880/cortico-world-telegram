/**
 * `MtprotoPort` 的实现（P0 子集）。
 *
 * 唯一允许 `new Api.X(...)` 的地方之一（另一个是后续的 impl/ 分片）。
 * 业务层只看到 `port.ts` 的领域类型。
 *
 * P0 实现：连接监督、登录 RPC、`me`、更新桥（消息 + updateMessageID）、`history`、`sendText`。
 * 其余方法按阶段抛 `UnsupportedError`，绝不返回假成功。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { isViewableImage, sniffImageMime } from '../media/image.ts';
import { PEER_FLOOD_PAUSE_MS, classifyFatal, peerFloodAllows } from './errors.ts';
import { ensureVoiceOgg } from '../media/voice.ts';
import { FLOOD_RETRY_MAX_SECONDS, RateLimiter, floodWaitSeconds } from './ratelimit.ts';
import { parseReactionUpdate } from './reactions.ts';
import { reactionSummary } from './message-reactions.ts';
import { Api, NewMessageEvent, StringSession, TelegramClient, forumTopics, utilsApi } from './lib.ts';
import { SentTracker } from './sent-tracker.ts';
import type { Credentials } from './credentials.ts';
import {
  UnsupportedError,
  type AccountInfo,
  type ChatInfo,
  type ChatKind,
  type ChatRef,
  type PeerCandidate,
  type ConnectionState,
  type DialogEntry,
  type DownloadResult,
  type HistoryOptions,
  type FolderInfo,
  type MediaInfo,
  type MemberInfo,
  type Msg,
  type MtprotoPort,
  type GifResult,
  type ReactionEntry,
  type SendFileOptions,
  type SendTextOptions,
  type SentRef,
  type StickerSetInfo,
  type StickerSetRef,
  type StickerInfo,
  type SyncQuality,
  type TopicInfo,
  type UpdateHandlers,
  type UserInfo,
} from './port.ts';

export interface ClientLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOG: ClientLogger = { info() {}, warn() {}, error() {}, debug() {} };

export interface MtprotoClientOptions {
  credentials: Credentials;
  /** 已保存的 StringSession 串；null = 新登录。 */
  session: string | null;
  transport?: { useWSS?: boolean; proxy?: string };
  appVersion?: string;
  /** 语音条转码用的 ffmpeg（默认走 PATH）。 */
  ffmpegPath?: string;
  /** 下载与转码产物的落地目录。 */
  mediaDir?: string;
  log?: ClientLogger;
  /** 发送限流：每会话最短间隔 + 每分钟全局上限。 */
  rateLimit?: { perChatMs?: number; globalPerMinute?: number };
  /** 断线后重新连上时回调（World 用它做消息级补课）。 */
  onReconnect?: () => void;
  /** 会话被其他设备终止时回调（World 据此停机提示重登）。 */
  onRevoked?: (detail: string) => void;
}

/** 5x 位随机 long，作为 random_id。 */
function randomLong(): bigint {
  const hi = BigInt(Math.floor(Math.random() * 0x7fffffff));
  const lo = BigInt(Math.floor(Math.random() * 0xffffffff));
  return (hi << 32n) | lo;
}

/** 临时目录（没配 mediaDir 时的下载落点）。 */
function temporaryDir(): string {
  return tmpdir();
}

function nowMs(): number {
  return Date.now();
}

function parseProxy(raw: string | undefined): Record<string, unknown> | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  if (s.startsWith('socks5://') || s.startsWith('socks://')) {
    const u = new URL(s.replace('socks://', 'socks5://'));
    const port = Number(u.port || 1080);
    const out: Record<string, unknown> = { ip: u.hostname, port, socksType: 5 };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  }
  throw new Error(`代理格式暂不支持：${s}（P0 只支持 socks5://host:port）`);
}

export class MtprotoClient implements MtprotoPort {
  private client: any = null;
  private conn: ConnectionState = { status: 'offline', since: nowMs() };
  private handlers: UpdateHandlers | null = null;
  private readonly tracker = new SentTracker();
  private readonly limiter: RateLimiter;
  private everOnline = false;
  private readonly log: ClientLogger;
  private readonly disposers: Array<() => void> = [];
  /** randomId → 等待 messageId 的 resolver（发送返回值里没带 id 时用）。 */
  private readonly idWaiters = new Map<string, (id: number) => void>();
  private revoked = false;
  /** 自己的账号 id / 用户名（登录后填，判定 @ 用）。 */
  private selfId = 0;
  private selfUsername?: string;

  constructor(private readonly opts: MtprotoClientOptions) {
    this.log = opts.log ?? NOOP_LOG;
    this.limiter = new RateLimiter(opts.rateLimit ?? {});
  }

  // ── 连接 ──────────────────────────────────────────────

  state(): ConnectionState {
    return { ...this.conn };
  }

  private setState(status: ConnectionState['status'], detail?: string): void {
    if (this.conn.status === status && this.conn.detail === detail) return;
    this.conn = { status, since: nowMs(), ...(detail ? { detail } : {}) };
    this.log.info('连接状态变化', { status, detail });
  }

  private ensureClient(): any {
    if (this.client) return this.client;
    const { credentials, session, transport } = this.opts;
    this.client = new TelegramClient(
      new StringSession(session ?? ''),
      credentials.apiId,
      credentials.apiHash,
      {
        connectionRetries: 5,
        autoReconnect: true,
        useWSS: transport?.useWSS ?? true,
        deviceModel: 'Coopanion Telegram World',
        systemVersion: process.platform === 'win32' ? 'Windows' : process.platform,
        appVersion: this.opts.appVersion ?? '0.2.0',
        langCode: 'zh',
        systemLangCode: 'zh-CN',
        ...(parseProxy(transport?.proxy) ? { proxy: parseProxy(transport?.proxy) } : {}),
      },
    );
    return this.client;
  }

  async connect(): Promise<void> {
    if (this.revoked) throw new Error('会话已被其他设备终止，请重新登录');
    const client = this.ensureClient();
    const wasOnline = this.conn.status === 'online';
    this.setState('connecting');
    try {
      await client.connect();
      this.setState('online');
      // 之前连上过、这次是重新连上 → 通知 World 做消息级补课
      if (this.everOnline && !wasOnline) {
        try {
          this.opts.onReconnect?.();
        } catch (error) {
          this.log.warn('onReconnect 回调失败', { reason: error instanceof Error ? error.message : String(error) });
        }
      }
      this.everOnline = true;
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // 连不上 DC 时给一句能照做的话：多半是网络到不了 Telegram，需要代理
      const friendly = /timed out|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ECONNRESET|TLS/i.test(raw)
        ? `连不上 Telegram 服务器（${raw.slice(0, 120)}）。这个网络多半访问不了 Telegram：`
          + '去「行为 → 网络」填一个 socks5 代理（例 socks5://127.0.0.1:1080），保存后重启 Coo。'
        : raw;
      this.setState('error', friendly);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 忽略：句柄可能已随连接释放
      }
    }
    this.handlers = null;
    try {
      await this.client?.disconnect();
    } catch {
      // 断开失败不影响本地状态
    }
    this.client = null;
    this.setState('offline');
  }

  syncQuality(): SyncQuality {
    // 增量恢复（updates.getDifference）由库内部的 UpdateManager 负责，我们不抢 pts（PLAN §13.3）。
    // 库没有稳定的公开状态可读，这里如实报告「未知」，面板显示为「库内部处理」。
    return { authoritative: false };
  }

  /** 把「会话失效」类错误统一转成停机 + 回调，避免上层无限重试。 */
  private isRevokedError(error: unknown): boolean {
    const info = classifyFatal(error instanceof Error ? error.message : String(error));
    return info !== null && info.stop === true;
  }

  private markRevoked(detail: string): void {
    if (this.revoked) return;
    this.revoked = true;
    const info = classifyFatal(detail);
    this.setState(info?.kind === 'banned' ? 'banned' : 'revoked', info?.human ?? detail);
    this.tracker.reset();
    this.opts.onRevoked?.(info?.human ?? detail);
  }

  /**
   * RPC 统一出口：会话失效 → 停机；`FLOOD_WAIT_X` → 短限流等一次再重试。
   *
   * 重试是安全的：发送用的是同一个 random_id（Telegram 按 random_id 去重），
   * 其他操作本身幂等。超过 60 秒的限流**不硬等**，直接如实报错。
   */
  /** PEER_FLOOD 罚站到期时间（毫秒）；0 = 没被罚。 */
  private peerFloodUntil = 0;

  /** 被 PEER_FLOOD 罚站到什么时候（面板/工具用来解释为什么发不出去）。 */
  peerFloodedUntil(): number {
    return this.peerFloodUntil > Date.now() ? this.peerFloodUntil : 0;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isRevokedError(error)) {
        this.markRevoked(message);
        throw error;
      }
      // PEER_FLOOD：不重试，记下罚站时间，让上层对陌生人静默
      const flood = classifyFatal(message);
      if (flood?.kind === 'peer-flood') {
        this.peerFloodUntil = Date.now() + PEER_FLOOD_PAUSE_MS;
        this.log.warn('遇到 PEER_FLOOD，暂停主动联系陌生人 24 小时', { until: this.peerFloodUntil });
        throw new Error(`[limited] ${flood.human}`);
      }
      const wait = floodWaitSeconds(message);
      if (wait === null) throw error;
      if (wait > FLOOD_RETRY_MAX_SECONDS) {
        throw new Error(`被 Telegram 限流 ${wait} 秒（超过 ${FLOOD_RETRY_MAX_SECONDS} 秒不自动等待），请稍后再试`);
      }
      this.log.warn('遇到 FloodWait，等一次再重试', { seconds: wait });
      await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
      return await fn();
    }
  }

  // ── 账号 / 登录 ───────────────────────────────────────

  async me(): Promise<AccountInfo> {
    const client = this.ensureClient();
    const user = await this.guard(() => client.getMe());
    const info = toAccount(user);
    // 记住自己是谁：群里判断 @ 用
    if (info.id > 0) this.selfId = info.id;
    if (info.username) this.selfUsername = info.username;
    return info;
  }

  async sendCode(phone: string): Promise<{ codeHash: string; viaApp: boolean }> {
    const client = this.ensureClient();
    if (!this.conn || this.conn.status !== 'online') await this.connect();
    const sent = await this.guard<{ phoneCodeHash: string; isCodeViaApp?: boolean }>(() =>
      client.sendCode({ apiId: this.opts.credentials.apiId, apiHash: this.opts.credentials.apiHash }, phone),
    );
    const { phoneCodeHash, isCodeViaApp } = sent;
    return { codeHash: String(phoneCodeHash), viaApp: !!isCodeViaApp };
  }

  async signIn(phone: string, codeHash: string, code: string): Promise<'ok' | 'password-needed'> {
    const client = this.ensureClient();
    try {
      await this.guard(() =>
        client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: codeHash, phoneCode: code })),
      );
      this.setState('online');
      return 'ok';
    } catch (error) {
      const m = (error instanceof Error ? error.message : String(error)).toUpperCase();
      if (m.includes('SESSION_PASSWORD_NEEDED')) return 'password-needed';
      throw error;
    }
  }

  async checkPassword(password: string): Promise<void> {
    const client = this.ensureClient();
    await this.guard(() =>
      client.signInWithPassword({
        password: async () => password,
        onError: (e: Error) => {
          throw e;
        },
      }),
    );
    this.setState('online');
  }

  saveSession(): string {
    const session = this.client?.session;
    return typeof session?.save === 'function' ? String(session.save()) : '';
  }

  /**
   * 只注销本连接这一条授权。
   * **绝不** `auth.resetAuthorizations` / `account.resetAuthorization`——那会踢掉 Desktop 和手机。
   */
  async logOut(): Promise<void> {
    if (this.client) {
      try {
        await this.client.invoke(new Api.auth.LogOut());
      } catch (error) {
        this.log.warn('auth.logOut 未成功', { reason: error instanceof Error ? error.message : String(error) });
      }
    }
    this.tracker.reset();
    await this.disconnect();
  }

  // ── 更新桥 ────────────────────────────────────────────

  onUpdates(handlers: UpdateHandlers): () => void {
    const client = this.ensureClient();
    this.handlers = handlers;

    const onMessage = (event: any): void => this.handleIncoming(event);
    client.addEventHandler(onMessage, new NewMessageEvent({}));
    this.disposers.push(() => client.removeEventHandler?.(onMessage, new NewMessageEvent({})));

    const onRaw = (update: any): void => {
      if (update?.className === 'UpdateMessageID') {
        const randomId = toBigInt(update.randomId);
        const id = Number(update.id) || 0;
        if (id > 0) this.handleMessageId(randomId, id);
        return;
      }
      // 反应变化：单独一类 update，不在这里接就永远看不见
      if (update?.className === 'UpdateMessageReactions' || update?.className === 'UpdateBotMessageReaction') {
        this.handleReactionUpdate(update);
        return;
      }
      // 编辑：对方改了内容，走的是 UpdateEditMessage，不是新消息
      if (update?.className === 'UpdateEditMessage' || update?.className === 'UpdateEditChannelMessage') {
        try {
          const edited = toMsg(update.message);
          (edited as { edited?: boolean }).edited = true;
          this.handlers?.onEditMessage?.(edited);
        } catch (error) {
          this.log.debug('编辑消息解析失败（忽略）', { reason: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      // 删除 / 撤回：只给 id 列表，正文拿不回来
      if (update?.className === 'UpdateDeleteMessages' || update?.className === 'UpdateDeleteChannelMessages') {
        try {
          const ids = (Array.isArray(update.messages) ? update.messages : [])
            .map((value: unknown) => Number(value))
            .filter((value: number) => Number.isFinite(value) && value > 0);
          if (!ids.length) return;
          const peer = update.peer
            ?? (update.channelId ? { className: 'PeerChannel', channelId: update.channelId } : undefined);
          const { id, kind } = peerIdOf({ peerId: peer });
          if (!id) return;
          this.handlers?.onDelete?.({ id, kind }, ids);
        } catch (error) {
          this.log.debug('删除更新解析失败（忽略）', { reason: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    // 不传事件构造器 = 订阅全部原始更新。
    // 探针实测：teleproto 的 events.Raw 构造函数要求 params，`new Raw()` 会直接抛
    // `Cannot read properties of undefined (reading 'func')`，所以这里用官方文档里的无参形式。
    client.addEventHandler(onRaw);
    this.disposers.push(() => client.removeEventHandler?.(onRaw));

    return () => {
      this.handlers = null;
      for (const dispose of this.disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // 忽略
        }
      }
    };
  }

  private handleMessageId(randomId: bigint, messageId: number): void {
    const claimed = this.tracker.onMessageId(randomId, messageId);
    const waiter = this.idWaiters.get(randomId.toString());
    if (waiter) {
      this.idWaiters.delete(randomId.toString());
      waiter(messageId);
    }
    this.log.debug('收到 updateMessageID', { messageId, claimed });
  }

  /**
   * 解析反应变化。
   *
   * 两个来源：
   *  - `UpdateMessageReactions`：某条消息的反应集合变了（对方点了/取消了）
   *  - `UpdateBotMessageReaction`：只发给 bot 账号，普通账号收不到
   *
   * 字段都很"可选"，这里一律降级处理，解析失败就当没收到——不能让反应把消息处理搞崩。
   */
  /** 解析反应变化并转给上层；解析不出来就静默丢掉，不能影响消息处理。 */
  private handleReactionUpdate(update: any): void {
    const handler = this.handlers?.onReaction;
    if (!handler) return;
    const parsed = parseReactionUpdate(update, (peer) => peerIdOf({ peerId: peer }));
    if (!parsed) {
      this.log.debug('反应更新解析不出来（忽略）', { className: String(update?.className ?? '') });
      return;
    }
    handler(parsed);
  }
  private handleIncoming(event: any): void {
    const raw = event?.message;
    if (!raw) return;
    let msg: Msg;
    try {
      msg = toMsg(raw);
    } catch (error) {
      this.log.warn('消息解析失败', { reason: error instanceof Error ? error.message : String(error) });
      return;
    }

    // 群里是否 @ 了本账号：用来决定要不要唤醒模型
    if (msg.chatKind !== 'user' && this.selfId > 0) {
      (msg as { mentionsMe?: boolean }).mentionsMe = mentionsUser(raw, this.selfId, this.selfUsername);
    }

    const verdict = this.tracker.classify({ chatId: msg.chatId, messageId: msg.id, out: msg.out });
    if (verdict.verdict === 'hold') {
      const token = verdict.token!;
      setTimeout(() => {
        // resolve 只会给 ours / self，不会给 hold
        this.emit(this.tracker.resolve(token), msg);
      }, 2100);
      return;
    }
    this.emit(verdict.verdict, msg);
  }

  private emit(verdict: 'ours' | 'self' | 'incoming', msg: Msg): void {
    const handlers = this.handlers;
    if (!handlers) return;
    const withFlag: Msg = verdict === 'ours' ? { ...msg, viaClient: true } : msg;
    handlers.onMessage(withFlag);
  }

  // ── 读 ────────────────────────────────────────────────

  async history(chat: ChatRef, opts: HistoryOptions = {}): Promise<Msg[]> {
    const client = this.ensureClient();
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    const entity = await this.guard(() => client.getInputEntity(chat.id));

    // 论坛话题要用 getReplies 读（普通 getHistory 会混进别的会话）
    if (opts.topicId) {
      const result = (await this.guard(() =>
        client.invoke(
          new Api.messages.GetReplies({
            peer: entity,
            msgId: opts.topicId!,
            offsetId: opts.beforeId ?? 0,
            offsetDate: 0,
            addOffset: 0,
            limit,
            maxId: 0,
            minId: 0,
            hash: 0,
          }),
        ),
      )) as any;
      const out: Msg[] = [];
      for (const raw of result?.messages ?? []) {
        try {
          out.push(toMsg(raw));
        } catch {
          // 服务消息跳过
        }
      }
      return out;
    }

    const messages = await this.guard(() =>
      client.getMessages(entity, {
        limit,
        ...(opts.beforeId ? { offsetId: opts.beforeId } : {}),
      }),
    );
    const list: Msg[] = [];
    for (const raw of (messages ?? []) as any[]) {
      try {
        list.push(toMsg(raw));
      } catch {
        // 单条解析失败不影响整批
      }
    }
    return list;
  }

  // ── 写 ────────────────────────────────────────────────

  async sendText(chat: ChatRef, text: string, opts: SendTextOptions = {}): Promise<SentRef> {
    const client = this.ensureClient();
    const body = text.trim();
    if (!body) throw new Error('消息正文为空');

    await this.limiter.acquire(chat.id);
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    const randomId = randomLong();
    // 关键：注册必须在 invoke 之前（PLAN §13.4）
    this.tracker.registerSend(randomId, chat.id);

    const idPromise = new Promise<number>((resolve) => {
      this.idWaiters.set(randomId.toString(), resolve);
      setTimeout(() => {
        if (this.idWaiters.delete(randomId.toString())) resolve(0);
      }, 1500);
    });

    const replyTo = opts.replyToId || opts.topicId
      ? new Api.InputReplyToMessage({
          replyToMsgId: opts.replyToId ?? 0,
          ...(opts.topicId ? { topMsgId: opts.topicId } : {}),
        })
      : undefined;

    const result = await this.guard(() =>
      client.invoke(
        new Api.messages.SendMessage({
          peer,
          message: body,
          randomId,
          noWebpage: opts.linkPreview === false,
          silent: !!opts.silent,
          ...(replyTo ? { replyTo } : {}),
        }),
      ),
    );

    const fromResult = extractMessageId(result);
    if (fromResult > 0) this.tracker.onMessageId(randomId, fromResult);
    const messageId = fromResult > 0 ? fromResult : await idPromise;
    if (messageId <= 0) {
      this.log.warn('发送成功但没拿到 message id', { chatId: chat.id });
    }
    return {
      chatId: chat.id,
      messageId,
      randomId,
      date: Math.floor(nowMs() / 1000),
    };
  }

  // ── 未实现（按阶段填）──────────────────────────────────

  async dialogs(limit = 100): Promise<DialogEntry[]> {
    const client = this.ensureClient();
    const capped = Math.max(1, Math.min(300, limit));
    const list = (await this.guard(() => client.getDialogs({ limit: capped }))) as any[];
    const out: DialogEntry[] = [];
    for (const dialog of list ?? []) {
      const entity = dialog?.entity;
      if (!entity) continue;
      const mapped = mapEntity(entity);
      if (!mapped) continue;
      const last = dialog.message;
      out.push({
        chat: { id: mapped.id, kind: mapped.kind, title: mapped.title },
        ...(mapped.username ? { username: mapped.username } : {}),
        lastMessageId: Number(last?.id ?? 0),
        lastDate: Number(dialog.date ?? last?.date ?? 0),
        unread: Number(dialog.unreadCount ?? 0),
        ...(mapped.bot ? { bot: true } : {}),
      });
    }
    this.dialogsCache = { at: Date.now(), list: out };
    return out;
  }

  /** 会话列表带 2 分钟缓存——按名字解析时会被反复读，不能每次都打网络。 */
  private dialogsCache?: { at: number; list: DialogEntry[] };

  private async dialogsCached(): Promise<DialogEntry[]> {
    const cache = this.dialogsCache;
    if (cache && Date.now() - cache.at < 120_000) return cache.list;
    try {
      return await this.dialogs(120);
    } catch {
      return cache?.list ?? [];
    }
  }

  async getMessage(chat: ChatRef, messageId: number): Promise<Msg | null> {
    const client = this.ensureClient();
    const entity = await this.guard(() => client.getInputEntity(chat.id));
    const list = (await this.guard(() => client.getMessages(entity, { ids: [messageId] }))) as any[];
    const raw = list?.[0];
    if (!raw) return null;
    return toMsg(raw);
  }

  async chatInfo(chat: ChatRef): Promise<ChatInfo> {
    const client = this.ensureClient();
    const entity = (await this.guard(() => client.getEntity(chat.id))) as any;
    const base = mapEntity(entity);
    if (!base) throw new Error(`拿不到会话 ${chat.id} 的资料`);
    const info: ChatInfo = { id: base.id, kind: base.kind, title: base.title };
    if (base.username) info.username = base.username;

    // 详情（简介/人数/是否论坛）能拿就拿，拿不到不算失败——权限不足是常态
    try {
      if (entity?.className === 'Channel') {
        const input = new Api.InputChannel({ channelId: entity.id, accessHash: entity.accessHash });
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel: input }));
        const chatFull = full?.fullChat;
        if (chatFull?.about) info.about = String(chatFull.about);
        if (chatFull?.participantsCount) info.membersCount = Number(chatFull.participantsCount);
        if (chatFull?.forum) info.isForum = true;
      } else if (entity?.className === 'Chat') {
        const full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
        const chatFull = full?.fullChat;
        if (chatFull?.about) info.about = String(chatFull.about);
        if (chatFull?.participantsCount) info.membersCount = Number(chatFull.participantsCount);
      } else if (entity?.className === 'User') {
        const input = new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash });
        const full = await client.invoke(new Api.users.GetFullUser({ id: input }));
        if (full?.fullUser?.about) info.about = String(full.fullUser.about);
      }
    } catch (error) {
      this.log.debug('会话详情不全（权限或隐私限制）', { chatId: chat.id, reason: String(error) });
    }
    return info;
  }

  async search(chat: ChatRef, query: string, limit = 20): Promise<Msg[]> {
    const client = this.ensureClient();
    const q = query.trim();
    if (!q) throw new Error('搜索关键词为空');
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    const result = (await this.guard(() =>
      client.invoke(
        new Api.messages.Search({
          peer,
          q,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit: Math.max(1, Math.min(100, limit)),
          maxId: 0,
          minId: 0,
          hash: 0,
        }),
      ),
    )) as any;
    const out: Msg[] = [];
    for (const raw of result?.messages ?? []) {
      try {
        out.push(toMsg(raw));
      } catch {
        // 服务消息等跳过
      }
    }
    return out;
  }

  /**
   * 按名字/用户名/id/链接搜会话。
   * 顺序：本地会话缓存 → @username 精确解析 → contacts.Search。
   * 返回候选（可能多个），由调用方决定是否唯一。
   */
  async searchPeers(query: string): Promise<PeerCandidate[]> {
    const raw = query.trim();
    if (!raw) return [];
    const needle = raw.toLowerCase().replace(/^@/, '');
    const found = new Map<number, PeerCandidate>();
    const push = (candidate: PeerCandidate | null): void => {
      if (candidate && !found.has(candidate.id)) found.set(candidate.id, candidate);
    };

    for (const dialog of await this.dialogsCached()) {
      const title = (dialog.chat.title ?? '').toLowerCase();
      const username = (dialog.username ?? '').toLowerCase();
      if (title.includes(needle) || username === needle || String(dialog.chat.id) === raw) {
        push({
          id: dialog.chat.id,
          kind: dialog.chat.kind,
          title: dialog.chat.title ?? String(dialog.chat.id),
          ...(dialog.username ? { username: dialog.username } : {}),
        });
      }
    }
    // 缓存的标题命中已经够用时就不打网络（省钱也省 FloodWait）
    if (found.size > 0) return [...found.values()].slice(0, 20);

    const uname = usernameFrom(raw);
    if (uname) {
      const resolved = await this.tryResolveUsername(uname);
      if (resolved) push(resolved);
    }

    const client = this.ensureClient();
    try {
      const res = await client.invoke(new Api.contacts.Search({ q: raw, limit: 20 }));
      for (const user of res?.users ?? []) push(mapEntity(user));
      for (const chat of res?.chats ?? []) push(mapEntity(chat));
    } catch (error) {
      this.log.debug('contacts.Search 失败', { reason: String(error) });
    }
    return [...found.values()].slice(0, 20);
  }

  async resolveUsername(raw: string): Promise<PeerCandidate | null> {
    const uname = usernameFrom(raw);
    if (!uname) return null;
    return this.tryResolveUsername(uname);
  }

  private async tryResolveUsername(username: string): Promise<PeerCandidate | null> {
    const client = this.ensureClient();
    try {
      const res = await client.invoke(new Api.contacts.ResolveUsername({ username }));
      const entity = res?.chats?.[0] ?? res?.users?.[0];
      return entity ? mapEntity(entity) : null;
    } catch (error) {
      this.log.debug('ResolveUsername 失败', { username, reason: String(error) });
      return null;
    }
  }


  /** 论坛话题列表。非论坛群会返回空数组（不是错误——调用方据此说"这不是论坛群"）。 */
  async topics(chat: ChatRef): Promise<TopicInfo[]> {
    const client = this.ensureClient();
    const forum = forumTopics();
    if (!forum) throw new UnsupportedError('P5', '论坛话题（当前 MTProto 库缺 channels/messages.GetForumTopics）');
    const input = await this.inputChannel(chat.id);
    const result = (await this.guard(() =>
      client.invoke(
        new forum.get({
          channel: input,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit: 100,
          hash: 0,
        }),
      ),
    )) as any;

    const out: TopicInfo[] = [];
    for (const topic of result?.topics ?? []) {
      if (topic?.className !== 'ForumTopic') continue; // 跳过 ForumTopicDeleted
      out.push({
        id: Number(topic.id),
        title: String(topic.title ?? ''),
        closed: topic.closed === true,
        pinned: topic.pinned === true,
      });
    }
    return out;
  }

  /** 群成员 / 频道订阅者。基础群和超级群都走库的 getParticipants。 */
  async participants(
    chat: ChatRef,
    opts: { limit?: number; offset?: number; adminsOnly?: boolean; query?: string } = {},
  ): Promise<MemberInfo[]> {
    const client = this.ensureClient();
    const entity = await this.guard(() => client.getEntity(chat.id));
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const query = (opts.query ?? '').trim();
    const filter = query
      ? new Api.ChannelParticipantsSearch({ q: query })
      : opts.adminsOnly
        ? new Api.ChannelParticipantsAdmins()
        : new Api.ChannelParticipantsRecent();

    const users = (await this.guard(() =>
      client.getParticipants(entity, {
        limit,
        ...(opts.offset ? { offset: opts.offset } : {}),
        filter,
      }),
    )) as any[];

    const out: MemberInfo[] = [];
    for (const user of users ?? []) {
      const mapped = toMember(user);
      if (mapped) out.push(mapped);
    }
    return out;
  }


  async editText(chat: ChatRef, messageId: number, text: string): Promise<void> {
    const client = this.ensureClient();
    const body = text.trim();
    if (!body) throw new Error('新正文为空');
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    await this.guard(() =>
      client.invoke(new Api.messages.EditMessage({ peer, id: messageId, message: body })),
    );
  }

  /** 返回删除条数。`revoke` 对自己消息表示双方都删。 */
  async deleteMessages(chat: ChatRef, ids: number[], revoke: boolean): Promise<number> {
    const client = this.ensureClient();
    const list = ids.filter((id) => Number.isFinite(id) && id > 0);
    if (!list.length) throw new Error('没有有效的 message id');
    if (isChannelId(chat.id)) {
      const input = await this.inputChannel(chat.id);
      await this.guard(() => client.invoke(new Api.channels.DeleteMessages({ channel: input, id: list })));
    } else {
      await this.guard(() => client.invoke(new Api.messages.DeleteMessages({ id: list, revoke })));
    }
    return list.length;
  }

  async forward(from: ChatRef, ids: number[], to: ChatRef): Promise<SentRef[]> {
    const client = this.ensureClient();
    const list = ids.filter((id) => Number.isFinite(id) && id > 0);
    if (!list.length) throw new Error('没有有效的 message id');
    const fromPeer = await this.guard(() => client.getInputEntity(from.id));
    const toPeer = await this.guard(() => client.getInputEntity(to.id));
    const result = (await this.guard(() =>
      client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer,
          id: list,
          toPeer,
          randomId: list.map(() => randomLong()),
        }),
      ),
    )) as any;

    const out: SentRef[] = [];
    for (const update of result?.updates ?? []) {
      const message = update?.message;
      if (update?.className === 'UpdateNewMessage' && message?.id) {
        out.push({
          chatId: to.id,
          messageId: Number(message.id),
          randomId: 0n,
          date: Number(message.date ?? Math.floor(nowMs() / 1000)),
        });
      }
    }
    return out;
  }

  async react(chat: ChatRef, messageId: number, emoji: string): Promise<void> {
    const client = this.ensureClient();
    const value = emoji.trim();
    if (!value) throw new Error('emoji 为空');
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    await this.guard(() =>
      client.invoke(
        new Api.messages.SendReaction({
          peer,
          msgId: messageId,
          reaction: [new Api.ReactionEmoji({ emoticon: value })],
        }),
      ),
    );
  }

  /**
   * 标记已读。
   * 注意：这是**账号级**副作用，会消掉 Desktop/手机的未读红点——默认不自动调用（PLAN §12.2）。
   */
/**
   * 设置本连接的在线状态。
   * `offline: true` 只影响**这条连接**，不会把你手机/桌面踢下线。
   */
  async setOnline(online: boolean): Promise<void> {
    const client = this.ensureClient();
    await this.guard(() => client.invoke(new Api.account.UpdateStatus({ offline: !online })));
  }

  /** 在会话里显示「正在输入」。失败不致命（很多客户端本来就不显示）。 */
  async sendTyping(chat: ChatRef): Promise<void> {
    const client = this.ensureClient();
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    await this.guard(() => client.invoke(new Api.messages.SetTyping({
      peer,
      action: new Api.SendMessageTypingAction(),
    })));
  }
  async markRead(chat: ChatRef, upToId: number): Promise<void> {
    const client = this.ensureClient();
    if (isChannelId(chat.id)) {
      const input = await this.inputChannel(chat.id);
      await this.guard(() => client.invoke(new Api.channels.ReadHistory({ channel: input, maxId: upToId })));
      return;
    }
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    await this.guard(() => client.invoke(new Api.messages.ReadHistory({ peer, maxId: upToId })));
  }

  /** supergroup / channel 的 id 是 -100 前缀；这类操作要用 channels.* 而不是 messages.*。 */
  private async inputChannel(chatId: number): Promise<any> {
    const client = this.ensureClient();
    const entity = (await this.guard(() => client.getEntity(chatId))) as any;
    return new Api.InputChannel({ channelId: entity.id, accessHash: entity.accessHash });
  }

  async download(chat: ChatRef, messageId: number, destDir: string): Promise<DownloadResult> {
    const client = this.ensureClient();
    const entity = await this.guard(() => client.getInputEntity(chat.id));
    const list = (await this.guard(() => client.getMessages(entity, { ids: [messageId] }))) as any[];
    const msg = list?.[0];
    if (!msg) throw new Error(`找不到消息 #${messageId}`);
    const info = mediaOf(msg);
    if (!info) throw new Error(`消息 #${messageId} 没有媒体`);

    const dir = join(destDir, String(chat.id));
    mkdirSync(dir, { recursive: true });
    let path = join(dir, mediaFileName(info, messageId));

    const started = Date.now();
    // 下载重试：网络类错误再试两次（1s / 2s）；文件引用过期之类直接放弃
    let lastError: unknown;
    let downloaded = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.guard(() => client.downloadMedia(msg, { outputFile: path }));
        downloaded = true;
        break;
      } catch (error) {
        lastError = error;
        const reason = error instanceof Error ? error.message : String(error);
        if (attempt === 2 || !shouldRetryDownload(reason)) break;
        this.log.warn('下载失败，重试', { chatId: chat.id, messageId, attempt: attempt + 1, reason });
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    if (!downloaded && lastError) throw lastError;
    let bytes = existsSync(path) ? statSync(path).size : 0;
    if (bytes === 0) throw new Error('下载完成但文件是空的（可能已过期或被限制）');
    this.log.debug('媒体已下载', { chatId: chat.id, messageId, bytes, ms: Date.now() - started });

    // Telegram 的 photo 消息**不带 MIME**（`mediaOf` 只返回 kind），所以 `mediaFileName`
    // 算不出扩展名、`download` 也交不出 mime，下游会因为 `!!mime` 为 false 而不附预览。
    // 这里落盘后用魔术字节补判：补上 mime，并顺手把扩展名补齐。
    // 另外 document 的 mimeType 可能是 application/octet-stream 之类的占位值，所以
    // 「有 mime 但不是可视图格式」时也要嗅探一次，嗅出图片就以嗅探结果为准。
    let mime = info.mime;
    if (!mime || !isViewableImage(mime)) {
      try {
        const head = new Uint8Array(readFileSync(path).subarray(0, 12));
        const sniffed = sniffImageMime(head);
        if (sniffed) {
          mime = sniffed;
          const ext = extForMime(sniffed);
          if (ext && !path.toLowerCase().endsWith(`.${ext}`)) {
            const renamed = `${path}.${ext}`;
            if (!existsSync(renamed)) {
              renameSync(path, renamed);
              path = renamed;
              bytes = statSync(path).size;
            }
          }
        }
      } catch {
        // 嗅探失败就保持原样：文件已经落盘，不能因为认不出格式就把「已下载」变成失败
      }
    }

    return { path, bytes, ...(mime ? { mime } : {}) };
  }

  /**
   * 取图片字节，给**事件**附带用（模型一进上下文就能看图，不必先调工具）。
   * 不是图片 / 超上限 / 下载失败都返回 null——调用方照常投递文本。
   */
  async fetchImage(
    chat: ChatRef,
    messageId: number,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
    const destDir = this.opts.mediaDir ?? join(temporaryDir(), 'telegram');
    const result = await this.download(chat, messageId, destDir);
    if (result.bytes > maxBytes) {
      this.log.debug('图片超过上限，不附带', { bytes: result.bytes, maxBytes });
      return null;
    }
    const bytes = new Uint8Array(readFileSync(result.path));
    // photo 消息没有 MIME，靠魔术字节认；认不出来就当不是图片
    const mime = isViewableImage(result.mime) ? result.mime! : sniffImageMime(bytes);
    if (!isViewableImage(mime)) return null;
    return { bytes, mime: mime!, name: basename(result.path) };
  }

  /** 取缩略图（视频首帧 / 文件预览）。`downloadMedia(..., {thumb})` 只拉小图，不碰原始文件。 */
  async fetchThumbnail(
    chat: ChatRef,
    messageId: number,
  ): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
    const client = this.ensureClient();
    const entity = await this.guard(() => client.getInputEntity(chat.id));
    const list = (await this.guard(() => client.getMessages(entity, { ids: [messageId] }))) as any[];
    const msg = list?.[0];
    if (!msg?.media) return null;
    try {
      const buffer = (await client.downloadMedia(msg, { thumb: 0 })) as unknown as Uint8Array | undefined;
      if (!buffer || buffer.length === 0) return null;
      const bytes = new Uint8Array(buffer);
      const mime = sniffImageMime(bytes) ?? 'image/jpeg';
      return { bytes, mime, name: `thumb-${messageId}.jpg` };
    } catch (error) {
      this.log.debug('缩略图取不到', { messageId, reason: String(error) });
      return null;
    }
  }

  /** 一次发多张图（相册）。Telegram 上限 10 个。 */
  async sendAlbum(chat: ChatRef, filePaths: string[], caption?: string): Promise<SentRef[]> {
    const client = this.ensureClient();
    const paths = filePaths.map((p) => p.trim()).filter(Boolean);
    if (paths.length < 2) throw new Error('相册至少要有两个文件（单张请用 send_media）');
    if (paths.length > 10) throw new Error('Telegram 相册最多 10 个');
    for (const path of paths) {
      if (!existsSync(path)) throw new Error(`文件不存在：${path}`);
    }

    await this.limiter.acquire(chat.id);
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    const result = (await this.guard(() =>
      client.sendFile(peer, {
        file: paths,
        ...(caption ? { caption } : {}),
        supportsStreaming: true,
      }),
    )) as any;

    const items = Array.isArray(result) ? result : [result];
    const out: SentRef[] = [];
    for (const item of items) {
      const id = Number(item?.id ?? 0);
      if (id > 0) out.push({ chatId: chat.id, messageId: id, randomId: 0n, date: Math.floor(nowMs() / 1000) });
    }
    return out;
  }

  async sendFile(chat: ChatRef, filePath: string, opts: SendFileOptions = {}): Promise<SentRef> {
    const client = this.ensureClient();
    if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
    await this.limiter.acquire(chat.id);

    // 语音条：Telegram 只认 ogg/opus。别的格式先转码，转不了就如实报错（不假装已发语音）。
    let sendPath = filePath;
    if (opts.asVoice) {
      const converted = await ensureVoiceOgg(filePath, {
        ...(this.opts.ffmpegPath ? { ffmpegPath: this.opts.ffmpegPath } : {}),
        ...(this.opts.mediaDir ? { outDir: this.opts.mediaDir } : {}),
      });
      sendPath = converted.path;
      if (converted.converted) this.log.debug('音频已转码为语音条', { from: filePath, to: sendPath });
    }

    const size = statSync(sendPath).size;
    if (size <= 0) throw new Error('文件是空的');
    if (size > 2 * 1024 * 1024 * 1024) throw new Error('超过 Telegram 单文件上限 2GB');

    const peer = await this.guard(() => client.getInputEntity(chat.id));
    const randomId = randomLong();
    this.tracker.registerSend(randomId, chat.id);

    const result = await this.guard(() =>
      client.sendFile(peer, {
        file: sendPath,
        ...(opts.caption ? { caption: opts.caption } : {}),
        ...(opts.asVoice ? { voiceNote: true } : {}),
        ...(opts.forceDocument ? { forceDocument: true } : {}),
        ...(opts.replyToId ? { replyTo: opts.replyToId } : {}),
        supportsStreaming: true,
      }),
    );
    const messageId = Number((result as any)?.id ?? 0);
    // 高层 sendFile 内部自己生成 random_id，我们拿不到；但 RPC 返回值带 message id，
    // 用它认领 sentIds 同样能立刻结束隔离队列里的等待（PLAN §13.4 第 1 层）。
    if (messageId > 0) this.tracker.onMessageId(randomId, messageId);
    return { chatId: chat.id, messageId, randomId, date: Math.floor(nowMs() / 1000) };
  }

  // ── 表情包（sticker）──────────────────────────────────

  async searchStickerSets(query: string): Promise<StickerSetRef[]> {
    const client = this.ensureClient();
    const q = query.trim();
    if (!q) throw new Error('搜索关键词为空（可以用文字，也可以直接给一个 emoji）');
    const result = (await this.guard(() =>
      client.invoke(new Api.messages.SearchStickerSets({ q, hash: 0 })),
    )) as any;
    const out: StickerSetRef[] = [];
    for (const covered of result?.sets ?? []) {
      const set = covered?.set;
      if (!set?.shortName) continue;
      out.push({
        shortName: String(set.shortName),
        title: String(set.title ?? set.shortName),
        count: Number(set.count ?? 0),
      });
    }
    return out;
  }

  async stickerSet(shortName: string): Promise<StickerSetInfo> {
    const client = this.ensureClient();
    const name = shortName.trim().replace(/^https?:\/\/t\.me\/addstickers\//i, '');
    if (!name) throw new Error('贴纸包短名为空');
    const result = (await this.guard(() =>
      client.invoke(
        new Api.messages.GetStickerSet({
          stickerset: new Api.InputStickerSetShortName({ shortName: name }),
          hash: 0,
        }),
      ),
    )) as any;

    const emojiByDoc = new Map<string, string>();
    for (const pack of result?.packs ?? []) {
      for (const docId of pack?.documents ?? []) {
        emojiByDoc.set(String(docId), String(pack?.emoticon ?? ''));
      }
    }

    const stickers: StickerInfo[] = [];
    for (const doc of result?.documents ?? []) {
      const info = toStickerInfo(doc, emojiByDoc.get(String(doc?.id)));
      if (info) stickers.push(info);
    }
    const set = result?.set;
    return {
      shortName: name,
      title: String(set?.title ?? name),
      count: Number(set?.count ?? stickers.length),
      stickers,
    };
  }

  async sendSticker(chat: ChatRef, sticker: StickerInfo, replyToId?: number): Promise<SentRef> {
    const client = this.ensureClient();
    await this.limiter.acquire(chat.id);
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    const randomId = randomLong();
    this.tracker.registerSend(randomId, chat.id);

    const result = await this.guard(() =>
      client.invoke(
        new Api.messages.SendMedia({
          peer,
          media: new Api.InputMediaDocument({ id: inputDocumentOf(sticker) }),
          message: '',
          randomId,
          ...(replyToId ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: replyToId }) } : {}),
        }),
      ),
    );
    const messageId = extractMessageId(result);
    if (messageId > 0) this.tracker.onMessageId(randomId, messageId);
    return { chatId: chat.id, messageId, randomId, date: Math.floor(nowMs() / 1000) };
  }

  /**
   * 本地表情文件当表情发。
   *
   * 关键在 `attributes`：带上 `DocumentAttributeSticker` 才会被 Telegram 当表情渲染；
   * 视频表情（webm）还要补 `DocumentAttributeVideo(nosound, 512x512)`。
   * 没带属性的话，同样一个 png 只会显示成图片。
   */
  async sendLocalSticker(
    chat: ChatRef,
    filePath: string,
    opts: { emoji?: string; replyToId?: number } = {},
  ): Promise<SentRef> {
    const client = this.ensureClient();
    if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
    const ext = extname(filePath).toLowerCase();
    if (!['.png', '.webp', '.tgs', '.webm'].includes(ext)) {
      throw new Error(`本地表情只支持 png / webp / tgs / webm（收到 ${ext || '无扩展名'}）`);
    }

    await this.limiter.acquire(chat.id);
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    const randomId = randomLong();
    this.tracker.registerSend(randomId, chat.id);

    const attributes: any[] = [
      new Api.DocumentAttributeSticker({
        alt: (opts.emoji ?? '').trim(),
        stickerset: new Api.InputStickerSetEmpty(),
      }),
    ];
    if (ext === '.webm') {
      attributes.push(new Api.DocumentAttributeVideo({
        w: 512,
        h: 512,
        duration: 3,
        nosound: true,
        roundMessage: false,
        supportsStreaming: false,
      }));
    }

    const result = await this.guard(() =>
      client.sendFile(peer, {
        file: filePath,
        forceDocument: true,
        mimeType: ext === '.webm' ? 'video/webm' : ext === '.tgs' ? 'application/x-tgsticker' : ext === '.webp' ? 'image/webp' : 'image/png',
        attributes,
        supportsStreaming: true,
        ...(opts.replyToId ? { replyTo: opts.replyToId } : {}),
      }),
    );
    const messageId = Number((result as any)?.id ?? 0);
    if (messageId > 0) this.tracker.onMessageId(randomId, messageId);
    return { chatId: chat.id, messageId, randomId, date: Math.floor(nowMs() / 1000) };
  }

  async faveSticker(sticker: StickerInfo, unfave = false): Promise<void> {
    const client = this.ensureClient();
    await this.guard(() =>
      client.invoke(new Api.messages.FaveSticker({ id: inputDocumentOf(sticker), unfave })),
    );
  }

  /** 已收藏的贴纸。emoji 从 `packs` 里反查（`GetFavedStickers` 的 pack 结构与 stickerSet 一样）。 */
  async favedStickers(): Promise<StickerInfo[]> {
    const client = this.ensureClient();
    const result = (await this.guard(() => client.invoke(new Api.messages.GetFavedStickers({ hash: 0 })))) as any;
    const emojiByDoc = new Map<string, string>();
    for (const pack of result?.packs ?? []) {
      for (const docId of pack?.documents ?? []) {
        emojiByDoc.set(String(docId), String(pack?.emoticon ?? ''));
      }
    }
    const out: StickerInfo[] = [];
    for (const doc of result?.stickers ?? []) {
      const info = toStickerInfo(doc, emojiByDoc.get(String(doc?.id)));
      if (info) out.push(info);
    }
    return out;
  }

  async installStickerSet(shortName: string, archived = false): Promise<void> {
    const client = this.ensureClient();
    const name = shortName.trim();
    if (!name) throw new Error('贴纸包短名为空');
    await this.guard(() =>
      client.invoke(
        new Api.messages.InstallStickerSet({
          stickerset: new Api.InputStickerSetShortName({ shortName: name }),
          archived,
        }),
      ),
    );
  }

  async uninstallStickerSet(shortName: string): Promise<void> {
    const client = this.ensureClient();
    const name = shortName.trim();
    if (!name) throw new Error('贴纸包短名为空');
    await this.guard(() =>
      client.invoke(
        new Api.messages.UninstallStickerSet({
          stickerset: new Api.InputStickerSetShortName({ shortName: name }),
        }),
      ),
    );
  }

  // ── GIF 搜索（@gif 内联机器人）────────────────────────

  private readonly gifCache = new Map<string, { at: number; results: any[] }>();

  /** 走内联机器人 @gif 搜。这就是 Telegram 客户端那个「搜索」面板的后端。 */
  private async inlineGifResults(query: string): Promise<any[]> {
    const client = this.ensureClient();
    const q = query.trim();
    if (!q) throw new Error('GIF 搜索关键词为空');
    const cached = this.gifCache.get(q);
    if (cached && Date.now() - cached.at < 120_000) return cached.results;

    const bot = await this.guard(() => client.getInputEntity('gif'));
    // peer 是必填的「在哪个会话里搜」，用 Saved Messages
    const peer = await this.guard(() => client.getInputEntity('me'));
    const result = (await this.guard(() =>
      client.invoke(new Api.messages.GetInlineBotResults({ bot, peer, query: q, offset: '' })),
    )) as any;

    const usable = ((result?.results ?? []) as any[]).filter((item) => !!item?.document);
    this.gifCache.set(q, { at: Date.now(), results: usable });
    return usable;
  }

  async searchGifs(query: string): Promise<GifResult[]> {
    const results = await this.inlineGifResults(query);
    return results.map((item, index) => {
      const doc = item.document;
      const video = (doc?.attributes ?? []).find((a: any) => a?.className === 'DocumentAttributeVideo');
      const image = (doc?.attributes ?? []).find((a: any) => a?.className === 'DocumentAttributeImageSize');
      const title = String(item.title ?? item.description ?? '').trim();
      return {
        index,
        title: title || `GIF #${index}`,
        mime: String(doc?.mimeType ?? ''),
        size: Number(doc?.size ?? 0),
        ...(video?.w ? { width: Number(video.w), height: Number(video.h) } : {}),
        ...(!video?.w && image?.w ? { width: Number(image.w), height: Number(image.h) } : {}),
      };
    });
  }

  async sendGif(chat: ChatRef, query: string, index = 0): Promise<SentRef & { title?: string }> {
    const client = this.ensureClient();
    const results = await this.inlineGifResults(query);
    if (!results.length) throw new Error(`「${query}」没有搜到 GIF`);
    const at = index >= 0 && index < results.length ? index : 0;
    const picked = results[at]!;
    const doc = picked.document;

    await this.limiter.acquire(chat.id);
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    const randomId = randomLong();
    this.tracker.registerSend(randomId, chat.id);

    const result = await this.guard(() =>
      client.invoke(
        new Api.messages.SendMedia({
          peer,
          media: new Api.InputMediaDocument({
            id: new Api.InputDocument({
              id: doc.id,
              accessHash: doc.accessHash,
              fileReference: doc.fileReference,
            }),
          }),
          message: '',
          randomId,
        }),
      ),
    );
    const messageId = extractMessageId(result);
    if (messageId > 0) this.tracker.onMessageId(randomId, messageId);
    const title = String(picked.title ?? '').trim();
    return {
      chatId: chat.id,
      messageId,
      randomId,
      date: Math.floor(nowMs() / 1000),
      ...(title ? { title } : {}),
    };
  }

  async installedStickerSets(): Promise<StickerSetRef[]> {
    const client = this.ensureClient();
    const result = (await this.guard(() => client.invoke(new Api.messages.GetAllStickers({ hash: 0 })))) as any;
    const out: StickerSetRef[] = [];
    for (const set of result?.sets ?? []) {
      if (!set?.shortName) continue;
      out.push({
        shortName: String(set.shortName),
        title: String(set.title ?? set.shortName),
        count: Number(set.count ?? 0),
      });
    }
    return out;
  }

  async contacts(): Promise<UserInfo[]> {
    const client = this.ensureClient();
    const result = (await this.guard(() => client.invoke(new Api.contacts.GetContacts({ hash: 0 })))) as any;
    const out: UserInfo[] = [];
    for (const user of result?.users ?? []) {
      const mapped = toUserInfo(user);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  async userInfo(user: ChatRef): Promise<UserInfo> {
    const client = this.ensureClient();
    const entity = (await this.guard(() => client.getEntity(user.id))) as any;
    const base = toUserInfo(entity);
    if (!base) throw new Error(`拿不到用户 ${user.id} 的资料`);

    // 详情能拿就拿，拿不到不影响基础信息
    try {
      const input = new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash });
      const full = (await this.guard(() => client.invoke(new Api.users.GetFullUser({ id: input })))) as any;
      const fullUser = full?.fullUser;
      if (fullUser?.about) base.bio = String(fullUser.about);
      if (fullUser?.commonChatsCount !== undefined) base.commonChatsCount = Number(fullUser.commonChatsCount);
    } catch (error) {
      this.log.debug('用户详情不全（隐私限制）', { userId: user.id, reason: String(error) });
    }
    return base;
  }

  async commonChats(user: ChatRef, limit = 20): Promise<ChatRef[]> {
    const client = this.ensureClient();
    const entity = (await this.guard(() => client.getEntity(user.id))) as any;
    const input = new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash });
    const result = (await this.guard(() =>
      client.invoke(new Api.messages.GetCommonChats({ userId: input, maxId: 0, limit: Math.max(1, Math.min(100, limit)) })),
    )) as any;
    const out: ChatRef[] = [];
    for (const chat of result?.chats ?? []) {
      const mapped = mapEntity(chat);
      if (mapped) out.push({ id: mapped.id, kind: mapped.kind, title: mapped.title });
    }
    return out;
  }

  async addContact(user: ChatRef, opts: { firstName: string; lastName?: string; phone?: string }): Promise<void> {
    const client = this.ensureClient();
    const entity = (await this.guard(() => client.getEntity(user.id))) as any;
    const input = new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash });
    await this.guard(() =>
      client.invoke(
        new Api.contacts.AddContact({
          id: input,
          firstName: opts.firstName.trim() || String(entity.firstName ?? ''),
          lastName: (opts.lastName ?? String(entity.lastName ?? '')).trim(),
          phone: (opts.phone ?? '').trim(),
          addPhonePrivacyException: false,
        }),
      ),
    );
  }

  async deleteContact(user: ChatRef): Promise<void> {
    const client = this.ensureClient();
    const entity = (await this.guard(() => client.getEntity(user.id))) as any;
    const input = new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash });
    await this.guard(() => client.invoke(new Api.contacts.DeleteContacts({ id: [input] })));
  }

  // ── 日常操作：置顶 / 归档 / 收藏 / 反应 / 文件夹 ─────

  async pinMessage(chat: ChatRef, messageId: number, pin = true): Promise<void> {
    const client = this.ensureClient();
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    await this.guard(() =>
      client.invoke(
        new Api.messages.UpdatePinnedMessage({
          peer,
          id: messageId,
          silent: true,
          ...(pin ? {} : { unpin: true }),
        }),
      ),
    );
  }

  async archiveChat(chat: ChatRef, archive = true): Promise<void> {
    const client = this.ensureClient();
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    await this.guard(() =>
      client.invoke(
        new Api.folders.EditPeerFolders({
          folderPeers: [new Api.InputFolderPeer({ peer, folderId: archive ? 1 : 0 })],
        }),
      ),
    );
  }

  /** 转存收藏夹：转发到 Saved Messages。 */
  async saveMessage(chat: ChatRef, messageId: number): Promise<SentRef> {
    const client = this.ensureClient();
    const fromPeer = await this.guard(() => client.getInputEntity(chat.id));
    const toPeer = await this.guard(() => client.getInputEntity('me'));
    const randomId = randomLong();
    const result = (await this.guard(() =>
      client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer,
          id: [messageId],
          randomId: [randomId],
          toPeer,
        }),
      ),
    )) as any;

    const first = result?.updates?.find?.((item: any) => item?.className === 'UpdateNewMessage')?.message;
    const messageIdOut = Number(first?.id ?? 0);
    return { chatId: chat.id, messageId: messageIdOut, randomId, date: Math.floor(nowMs() / 1000) };
  }

  async messageReactions(chat: ChatRef, messageId: number): Promise<ReactionEntry[]> {
    const client = this.ensureClient();
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    const result = (await this.guard(() =>
      client.invoke(
        new Api.messages.GetMessageReactionsList({ peer, id: messageId, offset: '', limit: 100 }),
      ),
    )) as any;

    const names = new Map<number, string>();
    for (const user of result?.users ?? []) {
      const id = Number(user?.id ?? 0);
      if (!id) continue;
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
        || (user.username ? String(user.username) : String(id));
      names.set(id, name);
    }

    const out: ReactionEntry[] = [];
    for (const item of result?.reactions ?? []) {
      const reaction = item?.reaction;
      const emoji = String(reaction?.emoticon ?? reaction?.documentId ?? '').trim();
      if (!emoji) continue;
      const peerId = item?.peerId;
      const userId = Number(peerId?.userId ?? 0);
      out.push({
        emoji,
        userId,
        ...(names.get(userId) ? { name: names.get(userId)! } : {}),
      });
    }
    return out;
  }

  async folders(): Promise<FolderInfo[]> {
    const client = this.ensureClient();
    const result = (await this.guard(() => client.invoke(new Api.messages.GetDialogFilters()))) as any;
    const out: FolderInfo[] = [];
    const list = Array.isArray(result) ? result : result?.filters ?? [];
    for (const filter of list) {
      const id = Number(filter?.id ?? 0);
      if (!id) continue; // DialogFilterDefault 没有 id
      const title = String(filter?.title?.text ?? filter?.title ?? '').trim();
      out.push({ id, title: title || `文件夹 ${id}` });
    }
    return out;
  }

  async blockUser(user: ChatRef): Promise<void> {
    const client = this.ensureClient();
    const peer = await this.guard(() => client.getInputEntity(user.id));
    await this.guard(() => client.invoke(new Api.contacts.Block({ id: peer })));
  }

  async unblockUser(user: ChatRef): Promise<void> {
    const client = this.ensureClient();
    const peer = await this.guard(() => client.getInputEntity(user.id));
    await this.guard(() => client.invoke(new Api.contacts.Unblock({ id: peer })));
  }

  async blockedUsers(limit = 100): Promise<UserInfo[]> {
    const client = this.ensureClient();
    const result = (await this.guard(() =>
      client.invoke(new Api.contacts.GetBlocked({ offset: 0, limit: Math.max(1, Math.min(500, limit)) })),
    )) as any;
    const out: UserInfo[] = [];
    for (const user of result?.users ?? []) {
      const mapped = toUserInfo(user);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  /**
   * 静音 / 取消静音。
   * Telegram 用 `muteUntil`（unix 秒）表达：0 = 取消，2^31-1 = 永久。
   */
  async muteChat(chat: ChatRef, minutes: number): Promise<number> {
    const client = this.ensureClient();
    const peer = await this.guard(() => client.getInputEntity(chat.id));
    const muteUntil = muteUntilOf(minutes);
    await this.guard(() =>
      client.invoke(
        new Api.account.UpdateNotifySettings({
          peer: new Api.InputNotifyPeer({ peer }),
          settings: new Api.InputPeerNotifySettings({ muteUntil }),
        }),
      ),
    );
    return muteUntil;
  }
}

// ---------------------------------------------------------------------------
// TL 对象 → 领域类型（只在这里做，业务层不接触 Api.*）
// ---------------------------------------------------------------------------

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const anyValue = value as { toString?: () => string } | null;
  try {
    return BigInt(anyValue?.toString?.() ?? '0');
  } catch {
    return 0n;
  }
}

function toAccount(user: any): AccountInfo {
  return {
    id: Number(user?.id ?? 0),
    ...(user?.username ? { username: String(user.username) } : {}),
    ...(user?.firstName ? { firstName: String(user.firstName) } : {}),
    ...(user?.lastName ? { lastName: String(user.lastName) } : {}),
  };
}

/** 从 `messages.sendMessage` 的返回里挖出 message id。 */
export function extractMessageId(result: any): number {
  if (!result) return 0;
  if (result.className === 'UpdateShortSentMessage') return Number(result.id) || 0;
  if (Array.isArray(result.updates)) {
    for (const update of result.updates) {
      if (update?.className === 'UpdateMessageID') return Number(update.id) || 0;
      if (update?.className === 'UpdateNewMessage' && update.message?.out) {
        return Number(update.message.id) || 0;
      }
    }
  }
  return 0;
}

/** 把 peer 归一化成有符号 chat id（channel = -100xxxx，group = -xxx）。 */
export function peerIdOf(raw: any): { id: number; kind: Msg['chatKind'] } {
  const peer = raw?.peerId;
  const className = String(peer?.className ?? '');
  let id = 0;
  try {
    const normalized = utilsApi?.getPeerId?.(peer);
    if (normalized !== undefined && normalized !== null) id = Number(normalized);
  } catch {
    id = 0;
  }
  if (!Number.isFinite(id) || id === 0) {
    if (raw?.chatId !== undefined) id = Number(raw.chatId);
    else if (raw?.senderId !== undefined) id = Number(raw.senderId);
  }
  const kind: Msg['chatKind'] = className === 'PeerUser'
    ? 'user'
    : className === 'PeerChat'
      ? 'group'
      : className === 'PeerChannel'
        ? 'channel'
        : id < 0
          ? 'group'
          : 'user';
  return { id, kind };
}

/** 从 `@name` / `t.me/name` / `https://t.me/name` / `tg://resolve?domain=name` 里取用户名。 */
export function usernameFrom(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const direct = /^@([a-zA-Z][\w\d_]{2,})$/.exec(value);
  if (direct?.[1]) return direct[1];
  const link = /(?:t\.me|telegram\.me|telegram\.dog)\/([a-zA-Z][\w\d_]{2,})/i.exec(value);
  if (link?.[1]) return link[1];
  const tg = /[?&]domain=([a-zA-Z][\w\d_]{2,})/i.exec(value);
  if (tg?.[1]) return tg[1];
  return null;
}

/** -100 前缀 = supergroup 或 channel。 */
export function isChannelId(id: number): boolean {
  return id <= -1_000_000_000_000;
}

/** TL Document → 贴纸引用。id/accessHash 是 BigInteger，统一转 native bigint。 */
export function toStickerInfo(doc: any, emoji?: string): StickerInfo | null {
  if (!doc?.id) return null;
  try {
    return {
      id: BigInt(String(doc.id)),
      accessHash: BigInt(String(doc.accessHash ?? 0)),
      fileReference: (doc.fileReference ?? new Uint8Array()) as Uint8Array,
      ...(emoji ? { emoji } : {}),
      mime: String(doc.mimeType ?? ''),
    };
  } catch {
    return null;
  }
}

/** 发送/收藏时需要 InputDocument（fileReference 会过期，所以每次都从最新数据构造）。 */
export function inputDocumentOf(sticker: StickerInfo): any {
  return new Api.InputDocument({
    id: sticker.id,
    accessHash: sticker.accessHash,
    fileReference: sticker.fileReference,
  });
}

/**
 * 从包里挑一个贴纸：优先按 emoji 精确匹配，其次按序号（0 起）。
 * 序号越界时退回第一个——但会在回执里说明，不假装用户要的就是这个。
 */
export function pickSticker(
  stickers: readonly StickerInfo[],
  opts: { index?: number; emoji?: string } = {},
): { sticker: StickerInfo; note?: string } | null {
  if (!stickers.length) return null;
  const emoji = (opts.emoji ?? '').trim();
  if (emoji) {
    const matched = stickers.filter((s) => s.emoji === emoji);
    if (matched.length) return { sticker: matched[0]! };
  }
  const index = Number.isFinite(opts.index) ? Number(opts.index) : 0;
  if (index >= 0 && index < stickers.length) return { sticker: stickers[index]! };
  return {
    sticker: stickers[0]!,
    note: `序号 ${index} 超出范围（共 ${stickers.length} 个），已改用第 1 个`,
  };
}

/** 静音分钟数 → Telegram 的 `muteUntil`（unix 秒）。0=取消，-1=永久。 */
export function muteUntilOf(minutes: number, now = Date.now()): number {
  if (!Number.isFinite(minutes) || minutes === 0) return 0;
  if (minutes < 0) return 2147483647; // 2^31-1 = forever
  return Math.floor(now / 1000) + Math.round(minutes * 60);
}

/**
 * 下载失败要不要重试。
 *
 * 网络抖动、超时、连接被重置 → 值得再试一次；
 * 文件引用过期、消息不存在、私有频道 → 重试一百次也没用，直接报错。
 */
export function shouldRetryDownload(message: string): boolean {
  const m = (message || '').toUpperCase();
  if (/FILE_REFERENCE_(EXPIRED|INVALID)|MESSAGE_ID_INVALID|MEDIA_EMPTY|CHANNEL_PRIVATE|USER_BANNED/.test(m)) {
    return false;
  }
  return /TIMEOUT|TIMED OUT|CONNECTION|NETWORK|ECONNRESET|EPIPE|RPC_CALL_FAIL|INTERNAL|FLOOD_WAIT|DOWNLOAD/.test(m);
}

/** `"a.jpg, b.jpg"` / 换行 / 数组 → 去重后的路径列表（最多 10 个，Telegram 相册上限）。 */
export function albumPaths(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\n,;]+/);
  const out: string[] = [];
  for (const item of raw) {
    const value = String(item ?? '').trim().replace(/^["']|["']$/g, '');
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out.slice(0, 10);
}

/**
 * 把用户/模型给的东西规整成 Telegram 能接受的贴纸包短名。
 *
 * 短名只能是 `[A-Za-z0-9_]`——中文标题、显示名、群名都不是短名，硬发会得到
 * `STICKERSET_INVALID`。这里提前拦下来，并说清楚怎么拿到真短名。
 */
export function normalizeStickerShortName(raw: string): { ok: true; shortName: string } | { ok: false; reason: string } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, reason: '短名为空' };

  const fromLink = /addstickers\/([A-Za-z0-9_]+)/i.exec(text)?.[1];
  const value = (fromLink ?? text.replace(/^@/, '')).trim();
  if (!value) return { ok: false, reason: `没从「${text}」里解析出短名` };

  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    return {
      ok: false,
      reason: `「${text}」不是短名：Telegram 短名只能是英文字母/数字/下划线（例：HotCherry）。`
        + '中文标题和搜索词都不行——先用 telegram_search_stickers 搜到括号里的短名，'
        + '或直接粘 t.me/addstickers/… 链接。',
    };
  }
  return { ok: true, shortName: value };
}

/** TL User → UserInfo。没有 id 的返回 null。 */
export function toUserInfo(user: any): UserInfo | null {
  const id = Number(user?.id ?? 0);
  if (!Number.isFinite(id) || id === 0) return null;
  return {
    id,
    ...(user?.username ? { username: String(user.username) } : {}),
    ...(user?.firstName ? { firstName: String(user.firstName) } : {}),
    ...(user?.lastName ? { lastName: String(user.lastName) } : {}),
    ...(user?.phone ? { phone: String(user.phone) } : {}),
    ...(user?.bot ? { bot: true } : {}),
  };
}

/** 群成员：把 GramJS 挂在 user 上的 `participant` 也读出来判管理员。 */
export function toMember(user: any): MemberInfo | null {
  const id = Number(user?.id ?? 0);
  if (!Number.isFinite(id) || id === 0) return null;
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
    || (user?.username ? String(user.username) : '')
    || String(id);
  const participantClass = String(user?.participant?.className ?? '');
  return {
    id,
    name,
    ...(user?.username ? { username: String(user.username) } : {}),
    ...(user?.bot ? { bot: true } : {}),
    ...(/Admin|Creator/i.test(participantClass) ? { admin: true } : {}),
  };
}

/** TL 实体（User / Chat / Channel）→ 归一化会话。id 规则与 messages 里保持一致。 */
export function mapEntity(entity: any): { id: number; kind: ChatKind; title: string; username?: string; bot?: boolean } | null {
  const cls = String(entity?.className ?? '');
  const rawId = Number(entity?.id ?? 0);
  if (!Number.isFinite(rawId) || rawId === 0) return null;

  if (cls === 'User') {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim()
      || (entity.username ? String(entity.username) : '')
      || String(rawId);
    return {
      id: rawId,
      kind: 'user',
      title: entity.self ? `${name}（我自己）` : name,
      ...(entity.username ? { username: String(entity.username) } : {}),
      ...(entity.bot ? { bot: true } : {}),
    };
  }
  if (cls === 'Chat') {
    // 老式群：id 取负
    return { id: -rawId, kind: 'group', title: String(entity.title ?? rawId) };
  }
  if (cls === 'Channel') {
    // 超级群与广播频道都用 -100 前缀
    return {
      id: -(1_000_000_000_000 + rawId),
      kind: entity.megagroup ? 'group' : 'channel',
      title: String(entity.title ?? rawId),
      ...(entity.username ? { username: String(entity.username) } : {}),
    };
  }
  return null;
}

/** 媒体落盘用的文件名：`tg-<消息id>-<kind>.<ext>`，只保留安全字符。 */
export function mediaFileName(info: MediaInfo, messageId: number): string {
  const ext = info.mime ? extForMime(info.mime) : '';
  const base = `tg-${messageId}-${info.kind}`.replace(/[^\w.-]+/g, '_');
  return ext ? `${base}.${ext}` : base;
}

export function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  // 有些客户端会把 JPEG 写成 image/jpg，光看 'jpeg' 会漏掉
  if (m.includes('jpeg') || m.endsWith('/jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('opus')) return 'opus';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('audio')) return 'audio';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('zip')) return 'zip';
  if (m.includes('text')) return 'txt';
  return '';
}

/** 人类可读的体积，回执里用。 */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`;
}
function mediaOf(raw: any): MediaInfo | undefined {
  const media = raw?.media;
  if (!media) return undefined;
  const className = String(media.className ?? '');
  if (className === 'MessageMediaPhoto') return { kind: 'photo' };
  if (className === 'MessageMediaWebPage' || className === 'MessageMediaEmpty') return undefined;

  // 非文件的几种：投票、联系人、位置、网页预览——都带上可读的正文，别只给个 other
  if (className === 'MessageMediaPoll') {
    const question = media.poll?.question;
    const text = typeof question === 'string' ? question : String(question?.text ?? '');
    return { kind: 'other', fileName: text ? '投票：' + text : '投票' };
  }
  if (className === 'MessageMediaContact') {
    const name = [media.firstName, media.lastName].filter(Boolean).join(' ').trim();
    const phone = media.phoneNumber ? String(media.phoneNumber) : '';
    return { kind: 'other', fileName: '联系人：' + (name || phone || '未知') };
  }
  if (className === 'MessageMediaGeo' || className === 'MessageMediaGeoLive') {
    const lat = media.geo?.lat;
    const lng = media.geo?.long;
    const coords = lat !== undefined && lng !== undefined ? Number(lat).toFixed(4) + ',' + Number(lng).toFixed(4) : '';
    return { kind: 'other', fileName: '位置：' + coords };
  }
  if (className !== 'MessageMediaDocument') return { kind: 'other' };

  const doc = media.document;
  const attrs: any[] = Array.isArray(doc?.attributes) ? doc.attributes : [];
  const has = (name: string): any => attrs.find((a) => a?.className === name);
  const video = has('DocumentAttributeVideo');
  const audio = has('DocumentAttributeAudio');
  const sticker = has('DocumentAttributeSticker');
  const animated = has('DocumentAttributeAnimated');
  const fileNameAttr = has('DocumentAttributeFilename');

  const kind: MediaInfo['kind'] = sticker
    ? 'sticker'
    : animated
      ? 'gif'
      : video
        ? 'video'
        : audio
          ? audio.voice
            ? 'voice'
            : 'audio'
          : 'document';

  // 音频/视频/语音的秒数：语音条和歌都要能看出多长
  const durationSec = audio?.duration !== undefined
    ? Number(audio.duration)
    : video?.duration !== undefined
      ? Math.round(Number(video.duration))
      : undefined;
  const emoji = sticker?.alt ? String(sticker.alt) : undefined;
  const performerTitle = [audio?.performer, audio?.title].filter(Boolean).join(' - ');

  return {
    kind,
    ...(doc?.mimeType ? { mime: String(doc.mimeType) } : {}),
    ...(doc?.size !== undefined ? { size: Number(doc.size) } : {}),
    ...(fileNameAttr?.fileName ? { fileName: String(fileNameAttr.fileName) } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(video?.w !== undefined ? { width: Number(video.w) } : {}),
    ...(video?.h !== undefined ? { height: Number(video.h) } : {}),
    ...(emoji ? { emoji } : {}),
    ...(performerTitle ? { title: performerTitle } : {}),
  };
}

/** 转发来源的可读名字（拿不到就不给）。 */
export function forwardedFrom(raw: any): string | undefined {
  const fwd = raw?.fwdFrom;
  if (!fwd) return undefined;
  const fromName = fwd.fromName;
  if (fromName) {
    const title = typeof fromName === 'string' ? fromName : String(fromName?.title ?? fromName?.firstName ?? '');
    if (title) return title;
  }
  if (fwd.fromId) {
    const id = Number(fwd.fromId.userId ?? fwd.fromId.channelId ?? fwd.fromId.chatId ?? 0);
    if (id) return '#' + id;
  }
  return undefined;
}

/** 这条消息是否 @ 了某个用户（按 entity 判定；文本 @用户名 作兜底）。 */
export function mentionsUser(raw: any, selfId: number, selfUsername?: string): boolean {
  const entities = raw?.entities ?? [];
  for (const entity of entities) {
    const cls = String(entity?.className ?? '');
    if (cls === 'MessageEntityMentionName' || cls === 'InputMessageEntityMentionName') {
      const uid = Number(entity?.userId ?? 0);
      if (uid > 0 && uid === selfId) return true;
    }
  }
  // 兜底：文本里出现 @本账号用户名（部分客户端不带 entity）
  if (selfUsername) {
    const needle = '@' + selfUsername.toLowerCase();
    if (String(raw?.message ?? '').toLowerCase().includes(needle)) return true;
  }
  return false;
}

export function toMsg(raw: any): Msg {
  const { id, kind } = peerIdOf(raw);
  const messageId = Number(raw?.id ?? 0);
  if (!Number.isFinite(messageId) || messageId <= 0) throw new Error('消息缺少 id');
  const replyTo = raw?.replyTo;
  const topicId = replyTo?.forumTopicId ?? replyTo?.replyToTopId;
  const media = mediaOf(raw);
  return {
    chatId: id,
    chatKind: kind,
    id: messageId,
    date: Number(raw?.date ?? 0),
    text: String(raw?.message ?? ''),
    ...(raw?.senderId !== undefined ? { senderId: Number(raw.senderId) } : {}),
    out: raw?.out === true,
    ...(replyTo?.replyToMsgId ? { replyToId: Number(replyTo.replyToMsgId) } : {}),
    ...(topicId ? { topicId: Number(topicId) } : {}),
    ...(media ? { media } : {}),
    ...(raw?.editDate ? { edited: true } : {}),
    ...(forwardedFrom(raw) ? { forwardedFrom: forwardedFrom(raw) } : {}),
    ...(reactionSummary(raw) ? { reactions: reactionSummary(raw) } : {}),
  };
}
