/**
 * Telegram World 主体。
 *
 * 职责边界：
 *  - 把 MTProto 更新变成 Coopanion 事件（`telegram.message` / `telegram.self`）
 *  - 把 Agent 的工具调用转给 `MtprotoPort` 实现
 *  - 管住生命周期：单连接、双开锁、会话失效即停
 * 不碰人格、记忆、模型——那些都在 Core 与 Persona 里。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger, StoragePart, ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldContext } from 'cortico/world.ts';

import { Approvals, classifyOwnerReply, parseApprovalCommand, renderApprovals, type ApprovalRequest, type GuardPolicy, type OwnerReply, type RiskKind } from './approval.ts';
import { enabledIds, telegramConfigGroup, telegramDefaults, type TelegramConfigSection } from './config.ts';
import { AuthMachine } from './mtproto/auth.ts';
import { MtprotoClient } from './mtproto/client.ts';
import { credentialFingerprint, describeCredentials, resolveCredentials, type Credentials } from './mtproto/credentials.ts';
import { ensureLib, libInfo, libLoadError, libReady, LIB_MISSING_HINT } from './mtproto/lib.ts';
import { GAP_CHECK_INTERVAL_MS, selectFreshMessages } from './inbound/catchup.ts';
import { formatQuoteMark } from './inbound/quote.ts';
import { formatFlags, formatMedia, formatReactions } from './inbound/render.ts';
import { DEFAULT_GROUP_TRIGGER, shouldWakeForGroup, type GroupTriggerMode } from './inbound/trigger.ts';
import { DepsInstaller, probeDeps, resolvePackageRoot } from './deps.ts';
import { NotifyGate } from './owner.ts';
import { AuditLog } from './audit.ts';
import { hardenFilesAcl } from './mtproto/acl.ts';
import { peerFloodAllows } from './mtproto/errors.ts';
import { actionForLocalSticker, decidePolicy, type ActionKind, type FilePolicy, type Verdict } from './policy.ts';
import { applyBehaviorPatch, behaviorFields, behaviorValues } from './settings.ts';
import { StickerTagStore, describeTag } from './stickers/tags.ts';

/** 模型真正能「看」的图片格式（tgs / webm 看不了）。 */
const VIEWABLE_STICKER = /\.(png|jpe?g|webp|gif)$/i;
import { cacheStats, clearMediaDir, humanSize, pruneMediaDir } from './media/cache.ts';
import { composeMergedMeta, composeMergedText, shouldBuffer, shouldFlush } from './inbound/merge.ts';
import type { MergePolicy } from './inbound/merge.ts';
import { normalizeStickerShortName, pickSticker } from './mtproto/client.ts';
import { isBlobHandle, resolveLocalFile, storeBlob } from './media/source.ts';
import type { AuthStatus, ChatRef, ConnectionState, Msg, ReactionUpdate } from './mtproto/port.ts';
import { InstanceLock, SessionStore, StateStore } from './mtproto/session-store.ts';
import {
  KIND_HINT,
  isLocalStickerUsable,
  localStickerForm,
  stickerMime,
  KIND_LABEL,
  RESOURCE_KINDS,
  ResourceIndex,
  describeResource,
  inspectAll,
  kindOfFile,
  resolveForSend,
  resolveWithinRoots,
  type SendPathPolicy,
  scanRecent,
  type ResourceDirs,
  type ResourceFile,
  type ResourceKind,
} from './resources.ts';
import { checkResourceDir, dirSizeHint } from './resources-guard.ts';
import { TELEGRAM_TOOL_DECLS, createTools, withAudit, type OpOutcome } from './tools.ts';
import { createPanel, type PanelDeps, type PanelStatus } from './webui/server.ts';

const ENV_PROMPT_PATH = fileURLToPath(new URL('./prompt/ENV_PROMPT.md', import.meta.url));

const NOOP_LOG: Logger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return NOOP_LOG; },
};

/** 去重窗口：同一 (chatId, messageId) 在 10 分钟内只处理一次。 */
const DEDUPE_TTL_MS = 10 * 60_000;
const DEDUPE_MAX = 4096;

export class TelegramWorld implements World {
  readonly id = 'telegram';

  private host?: WorldHost;
  private log: Logger = NOOP_LOG;
  private client?: MtprotoClient;
  private auth?: AuthMachine;
  private credentials?: Credentials;
  private readonly sessionStore: SessionStore;
  private readonly stateStore: StateStore;
  private readonly lock: InstanceLock;
  private readonly seen = new Map<string, number>();
  private readonly approvals: Approvals;
  private readonly resourceIndex: ResourceIndex;
  private readonly stickerTags: StickerTagStore;
  private readonly depsInstaller: DepsInstaller;
  private readonly notifyGate = new NotifyGate();
  /** S-11：审计日志（默认关，见 cfg.auditLog）。 */
  private readonly audit: AuditLog;
  /** 真正的扩展包根目录（不是 ctx.packageDir）。 */
  private readonly packageRoot: string;
  private lastError?: string;
  private needsRestart = false;

  constructor(private readonly ctx: WorldContext<TelegramConfigSection>) {
    this.sessionStore = new SessionStore(ctx.dataDir);
    this.stateStore = new StateStore(this.sessionStore.paths);
    // 审批有效期跟随配置（分钟 → 毫秒），以前是写死 5 分钟
    this.approvals = new Approvals({ ttlMs: Math.max(1, Number(this.cfg.approvalTtlMinutes) || 5) * 60_000 });
    this.lock = new InstanceLock(this.sessionStore.paths);
    this.audit = new AuditLog(join(this.sessionStore.paths.dir, 'audit.jsonl'), this.cfg.auditLog === true);
    this.resourceIndex = new ResourceIndex(join(this.sessionStore.paths.dir, 'resources.json'));
    this.stickerTags = new StickerTagStore(ctx.dataDir);
    // 部署态 ctx.packageDir 是 botDir（不含 node_modules），从模块位置反推真实包根
    this.packageRoot = resolvePackageRoot(import.meta.url, ctx.packageDir);
    this.depsInstaller = new DepsInstaller(this.packageRoot);
  }

  /**
   * 配置读取一律走这里。
   *
   * 部署里已有的 `worlds.telegram` 段是旧版写下的（只有 gatewayUrl 那几个键），
   * 框架不会补新键——所以必须和 `defaults()` 合并，否则 `watchSelf` 是 undefined，
   * 会被误判成 echo（自己跟自己聊起来）。
   */
  private get cfg(): TelegramConfigSection {
    const base = telegramDefaults();
    const raw = (this.ctx.cfg ?? {}) as Partial<TelegramConfigSection>;
    return {
      ...base,
      ...raw,
      transport: { ...base.transport, ...(raw.transport ?? {}) },
      allowUsers: Array.isArray(raw.allowUsers) ? raw.allowUsers : [],
      allowChats: Array.isArray(raw.allowChats) ? raw.allowChats : [],
    };
  }

  // ── 生命周期 ──────────────────────────────────────────

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log.child('telegram');

    const held = this.lock.acquire();
    if (held) {
      throw new Error(
        `另一个 Coopanion 实例正在使用这条会话（pid ${held.pid}）。双开会让 Telegram 作废本连接的授权，已拒绝启动。`,
      );
    }

    // S-09：启动时顺手加固会话文件的 ACL（Windows 上 chmod 不生效）
    void this.hardenSecretFiles();

    const cfg = this.cfg;
    // 依赖是懒加载的：这里先探一次。缺依赖时不抛死——面板要能打开，
    // 用户才有地方点「一键安装依赖」。
    try {
      await ensureLib();
    } catch {
      this.lastError = LIB_MISSING_HINT;
      this.log.warn('MTProto 依赖未就绪，先停在待安装状态', { reason: libLoadError() ?? '' });
      return;
    }
    // 审计日志跟随配置（改完重启 World 生效）
    this.audit.setEnabled(cfg.auditLog === true);
    const resolved = resolveCredentials({ apiId: cfg.apiId, apiHash: cfg.apiHash });
    if (!resolved.ok) {
      this.lock.release();
      throw new Error(`${resolved.error}${resolved.detail ? `：${resolved.detail}` : ''}`);
    }
    this.credentials = resolved.value;

    this.client = new MtprotoClient({
      credentials: this.credentials,
      session: this.sessionStore.read(),
      transport: cfg.transport,
      ...(cfg.ffmpegPath ? { ffmpegPath: cfg.ffmpegPath } : {}),
      mediaDir: this.sessionStore.paths.media,
      rateLimit: cfg.rateLimit,
      log: this.log,
      onReconnect: () => { void this.runCatchUp('reconnect'); },
      onRevoked: (detail) => {
        this.lastError = detail;
        this.log.warn('会话被其他设备终止，已停止重连', { detail });
      },
    });
    this.auth = new AuthMachine(this.client, this.sessionStore, this.log);
    this.client.onUpdates({
      onMessage: (msg) => { void this.handleMessage(msg); },
      onReaction: (info) => { void this.handleReaction(info); },
      onEditMessage: (msg) => { void this.handleEdit(msg); },
      onDelete: (chat, ids) => { void this.handleDelete(chat, ids); },
    });

    if (this.sessionStore.present()) {
      const status = await this.auth.restore();
      if (status.step === 'revoked') this.lastError = status.detail;
      if (status.step === 'error') this.lastError = status.detail;
      this.pruneMedia(true);
      // 启动时补一次：把停机期间漏掉的消息捞回来（消息级，不是完整更新恢复）
      if (status.step === 'authorized') void this.runCatchUp('start');
    }

    this.log.info('Telegram World 已启动', {
      lib: libInfo().id,
      credential: credentialFingerprint(this.credentials),
      session: this.sessionStore.describe().masked,
      account: this.auth.status().account?.id ?? null,
    });

    // 在线状态：默认保持沉默（不调 updateStatus），开了才主动上报，并定时续命
    this.applyPresence();

    // 运行中也补课：库的 difference 恢复偶尔漏消息（尤其手机在发、桌面在收时）
    if (this.cfg.catchUp) {
      this.gapTimer = setInterval(() => {
        void this.runCatchUp('gap');
      }, GAP_CHECK_INTERVAL_MS);
      this.gapTimer.unref?.();
    }
  }

  /** 运行中会话级补课的定时器（每 10 分钟一次，覆盖"在线但更新丢了"）。 */
  private gapTimer: ReturnType<typeof setInterval> | undefined;

  /** 在线状态定时器（只有 onlineWhileRunning 才会启动）。 */
  private presenceTimer?: ReturnType<typeof setInterval>;

  /**
   * 按配置维持在线状态。
   * `silent`（默认）= 一次都不调 `account.updateStatus`，你的手机/桌面该怎样还怎样。
   */
  private applyPresence(): void {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = undefined;
    }
    if (this.cfg.presence !== 'onlineWhileRunning') return;
    const beat = (): void => {
      void this.client?.setOnline(true).catch((error: unknown) => {
        this.log.debug('上报在线状态失败（忽略）', { reason: errText(error) });
      });
    };
    beat();
    this.presenceTimer = setInterval(beat, 60_000);
    this.presenceTimer.unref?.();
  }

  /** 发送前显示「正在输入」；开关关着或调用失败都不影响发送。 */
  private async showTyping(chat: ChatRef): Promise<void> {
    if (!this.cfg.typingIndicator) return;
    try {
      await this.client?.sendTyping(chat);
    } catch (error) {
      this.log.debug('发送正在输入失败（忽略）', { reason: errText(error) });
    }
  }

  async stop(): Promise<void> {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = undefined;
      // 只把这条连接标记为离线；你手机/桌面该怎样还怎样
      void this.client?.setOnline(false).catch(() => undefined);
    }
    if (this.gapTimer) {
      clearInterval(this.gapTimer);
      this.gapTimer = undefined;
    }
    // 停机前把缓冲的批次推出去，别把攒着的消息丢了
    this.flushAllMerged();
    // 状态游标是攒批写盘的：停机前必须落盘，否则最近 1 秒的进度会丢
    try {
      await this.stateStore.close();
    } catch (error) {
      this.log.warn('状态落盘失败', { reason: errText(error) });
    }
    try {
      await this.client?.disconnect();
    } finally {
      this.client = undefined;
      this.lock.release();
      this.log.info('Telegram World 已停止');
    }
  }

  /**
   * 关机前自检：只报告**已缓存的事实**，不在这里访问网络。
   * 关键一条——插件停机不会影响手机/Desktop 的登录。
   */
  shutdownVerification(language: Language = 'zh'): Array<{
    key: string;
    label: string;
    status: 'verified-ended' | 'still-live' | 'unknown';
    detail: string;
    manualAction: string;
  }> {
    const zh = language === 'zh' || language === 'zh-Hant' || language !== 'en';
    const auth = this.auth?.status();
    const authorized = auth?.step === 'authorized';
    const accountId = auth?.account?.id;
    const conn = this.client?.state().status ?? 'offline';
    const pending = this.approvals.list().length;
    const watch = enabledIds(this.cfg.allowUsers).size + enabledIds(this.cfg.allowChats).size;

    const checks: Array<{
      key: string;
      label: string;
      status: 'verified-ended' | 'still-live' | 'unknown';
      detail: string;
      manualAction: string;
    }> = [
      {
        key: 'telegram.session',
        label: zh ? 'Telegram 登录态' : 'Telegram session',
        // 授权是账号级的，插件停机不会结束它——如实报 still-live
        status: authorized ? 'still-live' : 'verified-ended',
        detail: authorized
          ? (zh
            ? `仍以账号 ${accountId ?? '?'} 登录；手机版和电脑版的登录是独立的，不受影响`
            : `Still signed in as ${accountId ?? '?'}; phone and Desktop sessions are independent`)
          : (zh ? '当前没有可用登录态' : 'No active session'),
        manualAction: authorized
          ? (zh ? '无需处理：插件停机不会踢掉其他设备；要彻底退出请在面板点「退出登录」' : 'Nothing to do; devices stay signed in')
          : '—',
      },
      {
        key: 'telegram.connection',
        label: zh ? 'MTProto 连接' : 'MTProto connection',
        status: conn === 'offline' ? 'verified-ended' : conn === 'online' ? 'still-live' : 'unknown',
        detail: zh ? `最后状态：${conn}` : `Last state: ${conn}`,
        manualAction: conn === 'offline' ? '—' : (zh ? '若仍显示在线，稍等几秒让库完成断开' : 'Wait a moment for the library to disconnect'),
      },
      {
        key: 'telegram.watch',
        label: zh ? '监听范围' : 'Watching',
        status: watch > 0 ? 'still-live' : 'verified-ended',
        detail: zh ? `${watch} 个会话在白名单里（停机后不再收取）` : `${watch} chats allowlisted`,
        manualAction: zh ? '—' : '—',
      },
    ];

    if (pending > 0) {
      checks.push({
        key: 'telegram.approvals',
        label: zh ? '待确认操作' : 'Pending confirmations',
        status: 'still-live',
        detail: zh ? `还有 ${pending} 个操作等待 !ok 确认，停机后作废` : `${pending} actions pending; they expire on shutdown`,
        manualAction: zh ? '在 Telegram 回 !no 取消，或等它过期' : 'Reply !no in Telegram or let them expire',
      });
    }
    return checks;
  }

  onTurnEnded(): void {
    // P0 没有草稿门（replyMode=direct），无需清理暂态
  }

  // ── 入站 ──────────────────────────────────────────────

  private isDuplicate(msg: Msg): boolean {
    const key = `${msg.chatId}:${msg.id}`;
    const now = Date.now();
    for (const [k, at] of this.seen) {
      if (now - at > DEDUPE_TTL_MS) this.seen.delete(k);
    }
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    if (this.seen.size > DEDUPE_MAX) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  private async handleMessage(msg: Msg, opts: { catchUp?: boolean } = {}): Promise<void> {
    const host = this.host;
    if (!host) return;
    if (this.isDuplicate(msg)) return;

    // `!ok` / `!no` / `!list` 由真人发来，属于控制指令：不进 Agent、不唤醒模型
    if (!msg.out) {
      const command = parseApprovalCommand(msg.text);
      if (command && this.isApproverMessage(msg)) {
        await this.handleApprovalCommand(command, msg);
        return;
      }
      // 白话回复也算：主人在私聊里回「可以 / 不行 / 随便你」就处理最近一条待批准
      if (this.isApproverMessage(msg) && this.approvals.size() > 0) {
        const reply = classifyOwnerReply(msg.text);
        if (reply) {
          await this.handleOwnerReply(reply, msg);
          return;
        }
      }
    }

    const cfg = this.cfg;

    // 自己账号发出的：本插件发的 / Desktop、手机发的，都走这里
    if (msg.viaClient || msg.out) {
      this.rememberOwnId(msg.chatId, msg.id);
      if (cfg.watchSelf === 'off') return;
      if (cfg.watchSelf === 'record') {
        await this.push(mkEvent('telegram.self', msg, this.render(msg), this.renderMeta(msg, opts)), { deliver: false });
        return;
      }
      // echo：当外部消息投递（可能自己跟自己聊起来）
      await this.push(mkEvent('telegram.self', msg, this.render(msg), this.renderMeta(msg, opts)), { trigger: 'flush' });
      return;
    }

    const gate = this.gate(msg);
    if (!gate.ok) {
      this.log.debug('消息未通过授权', { chatId: msg.chatId, reason: gate.reason });
      return;
    }
    const blobs = await this.mediaBlobs(msg);
    await this.deliver(msg, gate.trigger, opts, blobs);
    this.stateStore.bump(msg.chatId, msg.id, Date.now());
    // 自动标已读（默认关）：开了才会消掉你手机/桌面上的红点
    if (this.cfg.autoMarkRead) {
      try {
        await this.client?.markRead({ id: msg.chatId, kind: msg.chatKind }, msg.id);
      } catch (error) {
        this.log.debug('自动标已读失败（忽略）', { reason: errText(error) });
      }
    }
  }

  // ── 合并窗口 ──────────────────────────────────────────

  private readonly mergePending = new Map<number, {
    items: Array<{ text: string; meta: Record<string, unknown>; blobs: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }> }>;
    firstAt: number;
    lastAt: number;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  private mergePolicy(): MergePolicy {
    const cfg = this.cfg;
    return {
      windowMs: Math.max(0, Number(cfg.mergeWindowMs) || 0),
      maxAgeMs: Math.max(0, Number(cfg.mergeMaxAgeMs) || 0),
      maxItems: Math.max(1, Number(cfg.mergeMaxItems) || 1),
    };
  }

  /**
   * 投递一条已通过 gate 的消息：窗口内攒批，到点合成一条事件；窗口为 0 就直投。
   * 补课（catchUp）不攒批——那是恢复，攒起来只会整段灌进上下文。
   */
  private async deliver(
    msg: Msg,
    trigger: 'flush' | 'debounce',
    opts: { catchUp?: boolean },
    blobs: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }>,
  ): Promise<void> {
    const policy = this.mergePolicy();
    const quote = await this.quoteOf(msg);
    const text = this.render(msg, quote);
    const meta = this.renderMeta(msg, opts);

    if (opts.catchUp || !shouldBuffer(policy)) {
      await this.push(mkEvent('telegram.message', msg, text, meta), { trigger }, blobs);
      return;
    }

    const key = msg.chatId;
    const now = Date.now();
    const existing = this.mergePending.get(key);
    if (existing) {
      existing.items.push({ text, meta, blobs });
      existing.lastAt = now;
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = undefined;
      if (shouldFlush(existing.items.length, existing.firstAt, now, policy)) {
        await this.flushMerged(key);
        return;
      }
      this.armTimer(key, policy);
      return;
    }

    this.mergePending.set(key, { items: [{ text, meta, blobs }], firstAt: now, lastAt: now });
    this.armTimer(key, policy);
  }

  private armTimer(chatId: number, policy: MergePolicy): void {
    const entry = this.mergePending.get(chatId);
    if (!entry) return;
    const linger = Math.max(0, policy.windowMs - (Date.now() - entry.lastAt));
    entry.timer = setTimeout(() => { void this.flushMerged(chatId); }, linger);
    entry.timer.unref?.();
  }

  /** 已知的机器人会话（探测一次后缓存，避免每次调用都打 RPC）。 */
  private readonly botChatCache = new Map<number, boolean>();

  /** 判断某个私聊是不是 TG 机器人账号。 */
  private async isBotChat(chat: ChatRef): Promise<boolean> {
    if (chat.kind !== 'user') return false;
    if (typeof chat.bot === 'boolean') return chat.bot;
    const cached = this.botChatCache.get(chat.id);
    if (cached !== undefined) return cached;
    try {
      const entity = await this.client!.userInfo(chat);
      const isBot = (entity as { bot?: boolean }).bot === true;
      this.botChatCache.set(chat.id, isBot);
      return isBot;
    } catch {
      // 查不到就当真人处理（放宽，不是拒绝）
      return false;
    }
  }

  /**
   * 按会话类型判权限。返回 `allow` / `ask` / `deny`。
   * 群、频道、bot 账号是受限会话；私聊真人按「文件」配置走。
   */
  private async checkPolicy(
    chat: ChatRef,
    action: ActionKind,
  ): Promise<{ verdict: Verdict; reason?: string; isBot: boolean }> {
    const isBot = await this.isBotChat(chat);
    const result = decidePolicy({
      chatKind: chat.kind,
      isBot,
      action,
      filePolicy: (this.cfg.fileByWhitelisted ?? 'ask') as FilePolicy,
    });
    return { ...result, isBot };
  }

  /** 受限会话里做文件 / 危险操作 → 直接拒绝（带一句人话）。 */
  private async assertAllowed(chat: ChatRef, action: ActionKind): Promise<void> {
    const { verdict, reason } = await this.checkPolicy(chat, action);
    if (verdict === 'deny') throw new Error(`[denied] ${reason ?? '这里不能做这个操作'}`);
  }

  /** S-09：给会话文件补 ACL——Windows 上 chmod 只管只读位，真正的权限在 ACL。 */
  private async hardenSecretFiles(): Promise<void> {
    if (process.platform !== 'win32') return;
    try {
      const results = await hardenFilesAcl([this.sessionStore.paths.session]);
      for (const item of results) {
        if (item.ok && !item.skipped) this.log.info('已加固会话文件权限', { file: item.file });
        else if (!item.ok) this.log.warn('会话文件 ACL 加固失败（不影响使用）', { file: item.file, reason: item.reason });
      }
    } catch (error) {
      this.log.warn('会话文件 ACL 加固异常（不影响使用）', { reason: errText(error) });
    }
  }

  /** 这个路径是否位于「唱歌目录」内（唱歌算表演，不算外发文件）。 */
  private isSongDirPath(path: string): boolean {
    const dir = this.resourceDirs().song;
    if (!dir) return false;
    const norm = (value: string): string => {
      const unified = value.replace(/\\/g, '/').replace(/\/+$/, '');
      return process.platform === 'win32' ? unified.toLowerCase() : unified;
    };
    return norm(path).startsWith(`${norm(dir)}/`);
  }

  /** 入参可能是相对路径或 blob 句柄：解析后再判断是不是唱歌产物。 */
  private isSongFile(raw: string): boolean {
    try {
      return this.isSongDirPath(this.materializeSource(raw).path);
    } catch {
      return false;
    }
  }

  /** 发消息前的统一闸门：被 PEER_FLOOD 罚站时只放行白名单会话。 */
  private assertCanReach(chat: ChatRef): void {
    const allowlisted = this.isAllowlisted(chat);
    const until = this.client?.peerFloodedUntil() ?? 0;
    const check = peerFloodAllows({ until, allowlisted });
    if (!check.ok) throw new Error(`[limited] ${check.reason}`);
  }

  /** 通知收件地址：`ownerUserIds` 优先，否则用面板填的单个 ID。**不用于放行**。 */
  private ownerIds(): number[] {
    const list = (this.cfg.ownerUserIds ?? []).filter((id) => Number.isFinite(id) && id > 0);
    if (list.length) return list;
    const single = Number(this.cfg.ownerUserId);
    return Number.isFinite(single) && single > 0 ? [single] : [];
  }

  private async flushMerged(chatId: number): Promise<void> {
    const entry = this.mergePending.get(chatId);
    if (!entry) return;
    this.mergePending.delete(chatId);
    if (entry.timer) clearTimeout(entry.timer);

    const last = entry.items[entry.items.length - 1];
    if (!last) return;
    const text = composeMergedText(entry.items.map((item) => item.text));
    const ids = entry.items
      .map((item) => Number(item.meta.message_id ?? 0))
      .filter((id) => id > 0);
    const meta = composeMergedMeta(last.meta, ids, entry.items.length);
    const blobs = entry.items.flatMap((item) => item.blobs);
    const lastMsg: Msg = {
      chatId,
      chatKind: (last.meta.chat_kind as Msg['chatKind']) ?? 'user',
      id: ids[ids.length - 1] ?? 0,
      date: Math.floor(entry.lastAt / 1000),
      text,
      out: false,
    };

    if (entry.items.length > 1) {
      this.log.debug('合并投递', { chatId, merged: entry.items.length, chars: text.length });
    }
    await this.push(mkEvent('telegram.message', lastMsg, text, meta), { trigger: 'flush' }, blobs);
  }

  /** 停机/重启前把缓冲的批次推出去，别丢消息。 */
  private flushAllMerged(): void {
    for (const chatId of [...this.mergePending.keys()]) {
      void this.flushMerged(chatId);
    }
  }

  /** 媒体缓存清理：启动时清一次，之后每小时最多一次（清理是维护动作，不该拖慢消息）。 */
  private lastPruneAt = 0;

  private pruneMedia(force = false): void {
    const hours = this.cfg.mediaKeepHours;
    if (!Number.isFinite(hours) || hours <= 0) return;
    const now = Date.now();
    if (!force && now - this.lastPruneAt < 3_600_000) return;
    this.lastPruneAt = now;
    try {
      const result = pruneMediaDir(this.sessionStore.paths.media, hours);
      if (result.removed > 0) {
        this.log.info('清理媒体缓存', {
          removed: result.removed,
          freed: humanSize(result.bytes),
          kept: result.kept,
          keepHours: hours,
        });
      }
    } catch (error) {
      this.log.warn('清理媒体缓存失败', { reason: errText(error) });
    }
  }

  /** 手动清理（工具调用）。hours 省略时用配置；all=true 直接清空。 */
  private cleanupMedia(opts: { hours?: number; all?: boolean }): {
    removed: number;
    freedBytes: number;
    kept: number;
    remainingBytes: number;
    hours: number;
    all: boolean;
  } {
    const dir = this.sessionStore.paths.media;
    const configured = Number(this.cfg.mediaKeepHours);
    const hours = Number.isFinite(opts.hours) ? Number(opts.hours) : (Number.isFinite(configured) ? configured : 0);

    if (opts.all === true) {
      const result = clearMediaDir(dir);
      this.lastPruneAt = Date.now();
      return {
        removed: result.removed,
        freedBytes: result.bytes,
        kept: result.kept,
        remainingBytes: cacheStats(dir).bytes,
        hours: 0,
        all: true,
      };
    }
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error('没有可用的保留时长：请给 hours（小时），或用 all=true 清空；配置里 mediaKeepHours=0 表示不自动清理');
    }
    const result = pruneMediaDir(dir, hours);
    this.lastPruneAt = Date.now();
    return {
      removed: result.removed,
      freedBytes: result.bytes,
      kept: result.kept,
      remainingBytes: cacheStats(dir).bytes,
      hours,
      all: false,
    };
  }

  // ── 本地表情标签 ──────────────────────────────────────

  private localStickerFiles(limit = 500): ResourceFile[] {
    const dir = this.resourceDirs().sticker;
    if (!dir) return [];
    return scanRecent(dir, limit).filter((file) => isLocalStickerUsable(file.path));
  }

  /** 面板用：数量 + 形态分布 + 打标签进度（不列文件名，42 条太吵）。 */
  private stickerTagSummary(): {
    total: number;
    tagged: number;
    pending: number;
    byForm: { sticker: number; gif: number; photo: number };
  } {
    const files = this.localStickerFiles();
    const summary = this.stickerTags.summary(files);
    const byForm = { sticker: 0, gif: 0, photo: 0 };
    for (const file of files) {
      const form = localStickerForm(file.path);
      if (form) byForm[form] += 1;
    }
    return { ...summary, byForm };
  }

  /** 下一批待打标签的表情（附图片字节，让模型看得见）。 */
  private nextUntaggedStickers(count: number): {
    items: Array<{ name: string; path: string; size: number; form: string; mime: string; bytes: Uint8Array }>;
    remaining: number;
    skipped: number;
  } {
    const files = this.localStickerFiles();
    const pending = this.stickerTags.pending(files);
    const viewable = pending.filter((file) => VIEWABLE_STICKER.test(file.path));
    const skipped = pending.length - viewable.length; // tgs/webm 模型看不了
    const items: Array<{ name: string; path: string; size: number; form: string; mime: string; bytes: Uint8Array }> = [];
    for (const file of viewable.slice(0, Math.max(1, Math.min(10, count)))) {
      try {
        const bytes = new Uint8Array(readFileSync(file.path));
        if (bytes.length > 4 * 1024 * 1024) continue;
        items.push({
          name: file.name,
          path: file.path,
          size: file.size,
          form: localStickerForm(file.path) ?? 'sticker',
          mime: stickerMime(file.path),
          bytes,
        });
      } catch {
        // 读不到就跳过
      }
    }
    return { items, remaining: Math.max(0, viewable.length - items.length), skipped };
  }

  /**
   * 把图片直接挂到事件上——模型一进上下文就能"看见"，不用先调 download_media。
   *
   * 照片取原图（≤ maxMediaBytes）；视频/文件取**缩略图**（不下整段视频）。
   * 自己发的不取（那些事件是 deliver:false，浪费流量）。任何一步失败都返回空数组。
   */
  private async mediaBlobs(msg: Msg): Promise<Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }>> {
    if (!this.cfg.autoImages || !this.client || !this.host) return [];
    this.pruneMedia();
    const kind = msg.media?.kind;
    if (!kind) return [];
    const chat = { id: msg.chatId, kind: msg.chatKind };

    try {
      if (kind === 'photo' || kind === 'gif' || kind === 'sticker') {
        const image = await this.client.fetchImage(chat, msg.id, this.cfg.maxMediaBytes);
        if (!image) return [];
        if (!this.host.modelFacts.accepts(image.mime)) {
          this.log.debug('模型不支持这种图片格式，只给文本', { mime: image.mime });
          return [];
        }
        return [{ bytes: image.bytes, mime: image.mime, name: image.name, fallbackText: 'Telegram 图片' }];
      }

      // 视频 / 文档：只取缩略图，让模型看一眼预览帧
      if (!this.cfg.autoThumbnails) return [];
      if (kind !== 'video' && kind !== 'document') return [];
      const thumb = await this.client.fetchThumbnail(chat, msg.id);
      if (!thumb) return [];
      if (!this.host.modelFacts.accepts(thumb.mime)) return [];
      return [{ bytes: thumb.bytes, mime: thumb.mime, name: thumb.name, fallbackText: 'Telegram 预览图' }];
    } catch (error) {
      this.log.debug('附件没法附带（下载失败或已过期）', { messageId: msg.id, reason: errText(error) });
      return [];
    }
  }

  /** 授权判定：只响应白名单，其余丢弃（不落库）。 */
  private gate(msg: Msg): { ok: true; trigger: 'flush' | 'debounce' } | { ok: false; reason: string } {
    const cfg = this.cfg;
    if (msg.chatKind === 'user') {
      if (!cfg.watchPrivate) return { ok: false, reason: 'watchPrivate=false' };
      const allow = enabledIds(cfg.allowUsers);
      if (!allow.has(msg.chatId) && !(msg.senderId !== undefined && allow.has(msg.senderId))) {
        return { ok: false, reason: '不在 allowUsers' };
      }
      return { ok: true, trigger: 'flush' };
    }
    if (msg.chatKind === 'channel') {
      if (!cfg.watchChannel) return { ok: false, reason: 'watchChannel=false' };
    } else if (!cfg.watchGroup) {
      return { ok: false, reason: 'watchGroup=false' };
    }
    const allow = enabledIds(cfg.allowChats);
    if (!allow.has(msg.chatId)) return { ok: false, reason: '不在 allowChats' };

    // S-04：群里不是每条都该唤醒模型——没叫它就只记录
    const wake = shouldWakeForGroup({
      mode: (cfg.groupTrigger ?? DEFAULT_GROUP_TRIGGER) as GroupTriggerMode,
      mentionsMe: msg.mentionsMe === true,
      repliesToMe: msg.replyToId !== undefined && this.isOwnMessageId(msg.chatId, msg.replyToId),
      senderAllowlisted: msg.senderId !== undefined && enabledIds(cfg.allowUsers).has(msg.senderId),
    });
    if (!wake) return { ok: false, reason: '群消息没叫它（触发条件未满足）' };
    return { ok: true, trigger: 'debounce' };
  }

  /** 自己发过的消息 id（按会话记，判定"回复的是不是它"用）。 */
  private readonly ownMessageIds = new Map<number, Set<number>>();

  private rememberOwnId(chatId: number, messageId: number): void {
    if (!Number.isFinite(messageId) || messageId <= 0) return;
    const set = this.ownMessageIds.get(chatId) ?? new Set<number>();
    set.add(messageId);
    // 只留最近的 200 条，别无限长
    if (set.size > 200) {
      const first = set.values().next().value;
      if (first !== undefined) set.delete(first);
    }
    this.ownMessageIds.set(chatId, set);
  }

  private isOwnMessageId(chatId: number, messageId: number): boolean {
    return this.ownMessageIds.get(chatId)?.has(messageId) === true;
  }

  /**
   * 有人给消息点/撤了表情反应。
   *
   * 只关心**自己发过的消息**：别人之间的互动不该唤醒模型（那会变成噪音）。
   * 满足条件就当一条轻量事件推给宿主，并唤醒模型——这样它才知道"有人对我的话有反应"。
   */
  private async handleReaction(info: ReactionUpdate): Promise<void> {
    // 只认自己发过的消息 + 白名单里的会话，其它一律当噪音
    if (!this.isOwnMessageId(info.chatId, info.messageId)) return;
    if (!this.isAllowlisted({ id: info.chatId, kind: info.chatKind })) return;

    const where = info.chatKind === 'user' ? '私聊' : info.chatKind === 'group' ? '群' : '频道';
    const who = info.userName ?? (info.userId ? `#${info.userId}` : '某人');
    const what = info.emoticons.length ? info.emoticons.join(' ') : '反应';
    const text = info.removed
      ? `[反应] ${who} 取消了你在${where}里 #${info.messageId} 上的反应`
      : `[反应] ${who} 给你在${where}里 #${info.messageId} 的消息加了 ${what}`;

    this.log.info('收到表情反应', { chatId: info.chatId, messageId: info.messageId, who, what, removed: info.removed });

    await this.push(
      {
        type: 'telegram.reaction',
        text,
        meta: {
          chat_id: info.chatId,
          message_id: info.messageId,
          ...(info.userId ? { sender_id: info.userId } : {}),
          emoticons: info.emoticons,
          removed: info.removed,
        },
        senderKey: `chat:${info.chatId}`,
        ts: new Date().toISOString(),
      },
      { trigger: 'flush' },
    );
  }

  /** 别人编辑了消息：模型得知道内容变了，否则会一直引用旧说法。 */
  private async handleEdit(msg: Msg): Promise<void> {
    if (!this.isAllowlisted({ id: msg.chatId, kind: msg.chatKind })) return;
    const quote = await this.quoteOf(msg);
    const text = `[编辑] ${this.render(msg, quote)}`;
    await this.push(
      {
        type: 'telegram.edit',
        text,
        meta: this.renderMeta(msg),
        senderKey: `chat:${msg.chatId}`,
        ts: new Date().toISOString(),
      },
      { trigger: 'flush' },
    );
  }

  /** 消息被删除/撤回：正文已经拿不回来，只告诉模型哪些 id 没了。 */
  private async handleDelete(chat: ChatRef, ids: number[]): Promise<void> {
    if (!this.isAllowlisted(chat)) return;
    const list = ids.slice(0, 20).map((id) => `#${id}`).join(' ');
    const more = ids.length > 20 ? ` 等 ${ids.length} 条` : '';
    await this.push(
      {
        type: 'telegram.delete',
        text: `[删除] ${this.chatLabel(chat)} 里的消息 ${list}${more} 被删除或撤回`,
        meta: { chat_id: chat.id, chat_kind: chat.kind, message_ids: ids },
        senderKey: `chat:${chat.id}`,
        ts: new Date().toISOString(),
      },
      { trigger: 'flush' },
    );
  }

  private async push(
    event: { type: string; text: string; meta: Record<string, unknown>; senderKey: string; ts: string },
    opts: { deliver?: boolean; trigger?: 'flush' | 'debounce' | 'piggyback' },
    blobs?: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }>,
  ): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent(
        {
          type: event.type,
          ts: event.ts,
          source: this.id,
          text: event.text,
          senderKey: event.senderKey,
          meta: event.meta,
          ...(blobs && blobs.length ? { blobs } : {}),
        },
        opts,
      );
    } catch (error) {
      this.log.warn('事件投递失败', { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** 引用正文缓存：同一条被引用多次时不重复打 RPC。 */
  private readonly quoteCache = new Map<string, string>();

  /**
   * 取被引用那条消息的正文（截断）。
   * 拿不到就返回 undefined——宁可只显示编号，也不要编内容。
   */
  private async quoteOf(msg: Msg): Promise<string | undefined> {
    if (!msg.replyToId) return undefined;
    const key = msg.chatId + ':' + msg.replyToId;
    const cached = this.quoteCache.get(key);
    if (cached !== undefined) return cached || undefined;
    try {
      const quoted = await this.client?.getMessage({ id: msg.chatId, kind: msg.chatKind }, msg.replyToId);
      if (!quoted) {
        this.quoteCache.set(key, '');
        return undefined;
      }
      const who = quoted.senderName ? quoted.senderName + ': ' : '';
      const kindNote = quoted.media ? '[' + quoted.media.kind + ']' : '';
      const body = (quoted.text || kindNote).replace(/\s+/g, ' ').trim();
      const value = who + truncate(body, 120);
      if (this.quoteCache.size > 300) this.quoteCache.clear();
      this.quoteCache.set(key, value);
      return value || undefined;
    } catch (error) {
      this.log.debug('取引用正文失败', { chatId: msg.chatId, messageId: msg.replyToId, reason: errText(error) });
      this.quoteCache.set(key, '');
      return undefined;
    }
  }


  private render(msg: Msg, quote?: string): string {
    const where = msg.chatKind === 'user' ? '私聊' : msg.chatKind === 'channel' ? '频道' : '群';
    const who = msg.senderName ?? (msg.senderId !== undefined ? String(msg.senderId) : '未知');
    const parts: string[] = [];
    parts.push(msg.text.trim() ? msg.text : '(空)');
    const media = formatMedia(msg.media);
    if (media) parts.push(media);
    if (msg.replyToId) parts.push(formatQuoteMark(msg.replyToId, quote));
    const reactions = formatReactions(msg.reactions);
    if (reactions) parts.push(reactions);
    parts.push(...formatFlags(msg));
    return `[TG ${where} ${msg.chatId}] ${who}: ${parts.join(' ')}`;
  }

  private renderMeta(msg: Msg, opts: { catchUp?: boolean } = {}): Record<string, unknown> {
    return {
      platform: 'telegram',
      chat_id: msg.chatId,
      chat_kind: msg.chatKind,
      message_id: msg.id,
      ...(msg.senderId !== undefined ? { sender_id: msg.senderId } : {}),
      ...(msg.senderName ? { sender_name: msg.senderName } : {}),
      ...(msg.replyToId ? { reply_to: msg.replyToId } : {}),
      ...(msg.topicId ? { topic_id: msg.topicId } : {}),
      ...(msg.media ? { media_kind: msg.media.kind } : {}),
      ...(msg.viaClient ? { via_client: true } : {}),
      // 补课来的消息要能认出来：它只覆盖消息，不覆盖编辑/已读/成员变更
      ...(opts.catchUp ? { catch_up: true, recovery: 'message-history' } : {}),
    };
  }

  /**
   * 断线补课（消息级）。
   *
   * 只对白名单会话、只补 `lastSeenId` 之后、24 小时以内的消息，单次上限 200 条 / 20 个会话。
   * **不**声称是完整更新恢复——`updates.getDifference` 由库内部负责，我们补不到 other_updates。
   */
  private catchUpRunning = false;

  private async runCatchUp(reason: string): Promise<void> {
    if (!this.cfg.catchUp || this.catchUpRunning) return;
    if (this.auth?.status().step !== 'authorized' || !this.client) return;
    this.catchUpRunning = true;
    let delivered = 0;
    try {
      const cfg = this.cfg;
      const targets: ChatRef[] = [
        ...[...enabledIds(cfg.allowUsers)].map((id) => ({ id, kind: 'user' as const })),
        ...[...enabledIds(cfg.allowChats)].map((id) => ({
          id,
          kind: (id <= -1_000_000_000_000 ? 'channel' : 'group') as ChatRef['kind'],
        })),
      ].slice(0, 20);
      if (!targets.length) return;

      let budget = 200;
      for (const chat of targets) {
        if (budget <= 0) break;
        const cursor = this.stateStore.cursor(chat.id);
        let messages: Msg[] = [];
        try {
          messages = await this.client.history(chat, { limit: 50 });
        } catch (error) {
          this.log.debug('补课：读历史失败', { chatId: chat.id, reason: errText(error) });
          continue;
        }
        const fresh = selectFreshMessages(messages, {
          ...(cursor ? { lastSeenId: cursor.lastSeenId } : {}),
          limit: Math.min(budget, 50),
        });
        for (const msg of fresh) {
          await this.handleMessage(msg, { catchUp: true });
          budget -= 1;
          delivered += 1;
        }
      }
      if (delivered > 0) {
        this.log.info('断线补课完成（消息级，非完整更新恢复）', { delivered, reason });
      }
    } catch (error) {
      this.log.warn('断线补课失败', { reason: errText(error) });
    } finally {
      this.catchUpRunning = false;
    }
  }

  // ── 本地资源 ──────────────────────────────────────────

  /** 配置里的目录 + 内置回落（下载/临时）。 */
  private resourceDirs(): ResourceDirs {
    const raw = (this.cfg.resources ?? {}) as Partial<ResourceDirs>;
    const clean = (value: string | undefined): string => (value ?? '').trim();
    return {
      voice: clean(raw.voice),
      song: clean(raw.song),
      image: clean(raw.image),
      video: clean(raw.video),
      file: clean(raw.file),
      sticker: clean(raw.sticker),
      download: clean(raw.download) || this.sessionStore.paths.media,
    };
  }

  /** 所有允许访问的根目录：6 个资源目录 + bot 工作区（模型自己的产物）。 */
  private resourceRoots(): string[] {
    const dirs = this.resourceDirs();
    const roots = RESOURCE_KINDS.map((kind) => dirs[kind]).filter((p) => !!p);
    roots.push(join(this.ctx.botDir, 'workspace'));
    return [...new Set(roots)];
  }

  /** 最近生成的本地媒体（资源目录 + 登记索引），给「把刚才生成的语音发给我」用。 */
  private findLocalMedia(opts: { kind?: ResourceKind; query?: string; limit: number }): ResourceFile[] {
    const dirs = this.resourceDirs();
    const kinds = opts.kind ? [opts.kind] : RESOURCE_KINDS;
    const needle = (opts.query ?? '').toLowerCase();

    const byPath = new Map<string, ResourceFile>();
    for (const record of this.resourceIndex.list({ ...(opts.kind ? { kind: opts.kind } : {}), limit: opts.limit * 2 })) {
      byPath.set(record.path, {
        path: record.path,
        name: record.name,
        kind: record.kind,
        size: record.size,
        mtime: record.mtime,
      });
    }
    for (const kind of kinds) {
      for (const file of scanRecent(dirs[kind], 50)) {
        // 目录决定归类：唱歌目录里的 wav/mp3 都算「唱歌」，语音目录里的才算「语音」
        const tagged: ResourceFile = kind === 'song' || kind === 'voice'
          ? { ...file, kind }
          : file;
        if (!byPath.has(tagged.path)) byPath.set(tagged.path, tagged);
      }
    }
    return [...byPath.values()]
      .filter((file) => !needle
        || file.name.toLowerCase().includes(needle)
        || file.path.toLowerCase().includes(needle))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(1, opts.limit));
  }

  /** 登记别的 World 产出的文件；必须落在授权目录内。 */
  private registerLocalMedia(input: {
    filePath: string;
    kind?: ResourceKind;
    source?: string;
    note?: string;
  }): { ok: true; file: ResourceFile; source: string } | { ok: false; error: string } {
    const resolved = resolveWithinRoots(input.filePath, this.resourceRoots());
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (!existsSync(resolved.path)) return { ok: false, error: `文件不存在：${resolved.path}` };
    const stat = statSync(resolved.path);
    if (!stat.isFile()) return { ok: false, error: `不是文件：${resolved.path}` };

    const kind = input.kind ?? kindOfFile(resolved.path);
    const source = input.source?.trim() || 'local';
    this.resourceIndex.register({
      path: resolved.path,
      name: basename(resolved.path),
      kind,
      size: stat.size,
      mtime: stat.mtimeMs,
      source,
      ...(input.note ? { note: input.note } : {}),
    });
    return {
      ok: true,
      source,
      file: { path: resolved.path, name: basename(resolved.path), kind, size: stat.size, mtime: stat.mtimeMs },
    };
  }

  private envCache?: { at: number; vars: Record<string, string> };

  /**
   * 模板变量（规划 §12）：`telegram.*` 八件套。
   * 30 秒缓存——前缀重建比轮次频繁，会话列表/目录扫描没必要每次都做。
   * 未登录时不返回 null，而是给出明确说明，方便用户直接引用。
   */
  async envPromptVars(): Promise<Record<string, string>> {
    const now = Date.now();
    if (this.envCache && now - this.envCache.at < 30_000) return this.envCache.vars;
    const vars = await this.buildEnvVars();
    this.envCache = { at: now, vars };
    return vars;
  }

  private async buildEnvVars(): Promise<Record<string, string>> {
    const status = this.auth?.status();
    const conn = this.client?.state();
    const account = status?.account;
    const authorized = status?.step === 'authorized' && !!account;
    const cfg = this.cfg;
    const users = enabledIds(cfg.allowUsers);
    const chats = enabledIds(cfg.allowChats);

    const name = account
      ? [account.firstName, account.lastName].filter(Boolean).join(' ') || account.username || String(account.id)
      : '';
    const identity = authorized && account
      ? `名称 ${name}${account.username ? `(@${account.username})` : ''}，id ${account.id}；`
        + `连接 ${conn?.status ?? 'offline'}；监听白名单：私聊 ${users.size} 个、群/频道 ${chats.size} 个。`
      : `未登录（状态 ${status?.step ?? 'idle'}${status?.detail ? `：${status.detail}` : ''}）。`;

    const dirs = this.resourceDirs();
    const resources = inspectAll(dirs)
      .map((item) => {
        const label = KIND_LABEL[item.kind] ?? item.kind;
        if (!item.configured) return `- ${label}：未配置`;
        if (!item.exists) return `- ${label}：${item.path}（不存在）`;
        const newest = item.newest ? `，最新 ${describeResource(item.newest)}` : '';
        return `- ${label}：${item.path}（${item.files} 个文件${newest}）`;
      })
      .join('\n');

    const media = [
      `- 图片/视频/音频/文件：收发都支持；单文件上限 2GB；给模型看的字节上限 ${Math.round(cfg.maxMediaBytes / 1024 / 1024)}MB。`,
      `- 语音条：${cfg.ffmpegPath ? `可用（ffmpeg=${cfg.ffmpegPath}，自动转 ogg/opus）` : '未配置 ffmpeg'}`,
      '- 语音转写：不支持（MTProto 无公开转写接口），收到语音只能拿到文件。',
    ].join('\n');

    const preferences = [
      `- 默认语音发送方式：${cfg.preferences?.voiceSendAsVoice ? '语音条' : '普通音频'}`,
      `- 自动查找本地生成文件：${cfg.preferences?.autoFindLocalMedia ? '开' : '关'}`,
      `- 自身消息处理：${cfg.watchSelf}`,
      '- 只能给监听名单里的会话发消息（名单外的收不到，也不发）',
      `- 白名单私聊发文件：${cfg.fileByWhitelisted ?? 'ask'}（群 / 频道 / bot 账号不能发文件）`,
    ].join('\n');

    return {
      'telegram.account': authorized && account ? `你的 Telegram 账号是 ${name}，id ${account.id}。` : '尚未登录 Telegram。',
      'telegram.identity': identity,
      'telegram.conversations': await this.conversationsVar(users, chats),
      'telegram.contacts': await this.contactsVar(),
      'telegram.resources': resources,
      'telegram.media': media,
      'telegram.stickers': (() => {
        const dirs = this.resourceDirs();
        const tags = this.stickerTagSummary();
        const files = this.localStickerFiles();
        const tagged = files
          .map((file) => ({ file, tag: this.stickerTags.get(file.name) }))
          .filter((row) => row.tag && row.tag.size === row.file.size)
          .slice(0, 40)
          .map((row) => `- ${describeTag(row.file.name, row.tag)}`);
        const head = `表情包：Telegram 包可搜索/安装/发送；本地表情目录 ${dirs.sticker || '未配置'}（共 ${tags.total} 个，已打标签 ${tags.tagged}，待标 ${tags.pending}）。`;
        return [head, ...(tagged.length ? ['已打标签的本地表情（按意思挑）：', ...tagged] : ['本地表情还没打标签，可按需调用 telegram_tag_local_stickers。'])].join('\n');
      })(),
      'telegram.capabilities': TELEGRAM_TOOL_DECLS.map((tool) => tool.name).join('、'),
      'telegram.preferences': preferences,
    };
  }

  /** 会话变量：白名单 + 最近 15 个会话（60 秒缓存，避免每次前缀重建都打网络）。 */
  private convCache?: { at: number; text: string };
  private contactsCache?: { at: number; text: string };

  /**
   * 联系人变量：真实拉一次 `contacts.getContacts`，缓存 5 分钟。
   * 联系人变动不频繁，没必要每轮都打 API。
   */
  private async contactsVar(): Promise<string> {
    if (this.contactsCache && Date.now() - this.contactsCache.at < 300_000) return this.contactsCache.text;
    if (this.auth?.status().step !== 'authorized' || !this.client) {
      return '联系人：未登录，暂时读不到。';
    }
    try {
      const list = await this.client.contacts();
      const lines: string[] = [];
      if (!list.length) {
        lines.push('联系人：账号里还没有联系人。');
      } else {
        lines.push(`联系人（共 ${list.length} 个，列出前 30 个）：`);
        for (const user of list.slice(0, 30)) {
          const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || String(user.id);
          const meta = [
            user.username ? `@${user.username}` : '',
            String(user.id),
            user.bot ? 'Bot' : '',
          ].filter(Boolean).join(' ');
          lines.push(`- ${name}（${meta}）`);
        }
        if (list.length > 30) lines.push(`…还有 ${list.length - 30} 个，用 telegram_get_contacts 看全`);
      }
      lines.push('要资料/共同群：telegram_get_user_info / telegram_get_common_chats。');
      const text = lines.join('\n');
      this.contactsCache = { at: Date.now(), text };
      return text;
    } catch (error) {
      this.log.debug('读联系人失败', { reason: errText(error) });
      return '联系人：读取失败（权限或网络），可重试或看日志。';
    }
  }

  private async conversationsVar(users: Set<number>, chats: Set<number>): Promise<string> {
    if (this.convCache && Date.now() - this.convCache.at < 60_000) return this.convCache.text;
    const lines: string[] = [];
    if (!users.size && !chats.size) {
      lines.push('监听白名单为空：现在没有任何会话会唤醒你。');
    } else {
      lines.push('监听中（这些会话的消息会唤醒你）：');
      for (const id of users) lines.push(`- 私聊 ${id}`);
      for (const id of chats) lines.push(`- 群/频道 ${id}`);
    }
    if (this.auth?.status().step === 'authorized') {
      try {
        const dialogs = await this.client!.dialogs(20);
        if (dialogs.length) {
          lines.push('最近会话：');
          for (const dialog of dialogs.slice(0, 15)) {
            const watched = (dialog.chat.id < 0 ? chats : users).has(dialog.chat.id) ? ' ✓监听' : '';
            const handle = dialog.username ? ` @${dialog.username}` : '';
            lines.push(`- ${dialog.chat.title ?? dialog.chat.id}${handle}（${dialog.chat.kind} ${dialog.chat.id}）${watched}`);
          }
        }
      } catch (error) {
        lines.push(`（读不到会话列表：${errText(error)}）`);
      }
    } else {
      lines.push('（未登录，暂无会话列表）');
    }
    const text = lines.join('\n');
    this.convCache = { at: Date.now(), text };
    return text;
  }

  // ── 工具 ──────────────────────────────────────────────

  tools(): ToolDef[] {
    const defs = createTools({
      status: () => this.statusLine(),
      resolveChat: (raw) => this.resolveChat(raw),
      listChats: async ({ limit, kind, query }) => {
        this.assertReady();
        const all = await this.client!.dialogs(limit);
        const needle = (query ?? '').toLowerCase();
        return all.filter((d) => {
          if (kind && d.chat.kind !== kind) return false;
          if (!needle) return true;
          return (d.chat.title ?? '').toLowerCase().includes(needle)
            || (d.username ?? '').toLowerCase().includes(needle);
        }).slice(0, limit);
      },
      searchChats: async (query) => {
        this.assertReady();
        return this.client!.searchPeers(query);
      },
      chatInfo: async (chat) => {
        this.assertReady();
        return this.client!.chatInfo(chat);
      },
      topics: async (chat) => {
        this.assertReady();
        return this.client!.topics(chat);
      },
      participants: async (chat, opts) => {
        this.assertReady();
        return this.client!.participants(chat, opts);
      },
      contacts: async () => {
        this.assertReady();
        return this.client!.contacts();
      },
      userInfo: async (user) => {
        this.assertReady();
        return this.client!.userInfo(user);
      },
      commonChats: async (user, limit) => {
        this.assertReady();
        return this.client!.commonChats(user, limit);
      },
      addContact: async (user, opts) => this.guardOp(
        'contact_write',
        this.cfg.guard.contactWrite,
        `把 ${this.chatLabel(user)} 存入联系人`,
        String(user.id),
        async () => {
          await this.client!.addContact(user, opts);
          return `[联系人] 已添加 ${this.chatLabel(user)}`;
        },
      ),
      deleteContact: async (user) => this.guardOp(
        'contact_write',
        this.cfg.guard.contactWrite,
        `把 ${this.chatLabel(user)} 从联系人里删掉`,
        String(user.id),
        async () => {
          await this.client!.deleteContact(user);
          return `[联系人] 已删除 ${this.chatLabel(user)}`;
        },
      ),
      blockUser: async (user) => {
        // 拉黑是可感知、难回退的动作：即使策略是 auto，也留一条 warn 级日志
        this.log.warn('拉黑用户', { userId: user.id, policy: this.cfg.guard.blockUser });
        return this.guardOp(
          'contact_write',
          this.cfg.guard.blockUser,
          `拉黑 ${this.chatLabel(user)}（对方不能再发消息）`,
          String(user.id),
          async () => {
            await this.client!.blockUser(user);
            return `[拉黑] 已拉黑 ${this.chatLabel(user)}；要撤销用 telegram_unblock_user`;
          },
        );
      },
      unblockUser: async (user) => {
        try {
          await this.client!.unblockUser(user);
          return { status: 'done', message: `[拉黑] 已解除 ${this.chatLabel(user)}` };
        } catch (error) {
          return { status: 'denied', message: `[failed] 解除失败：${errText(error)}` };
        }
      },
      blockedUsers: async (limit) => {
        this.assertReady();
        return this.client!.blockedUsers(limit);
      },
      muteChat: async (chat, minutes) => {
        this.assertReady();
        return this.client!.muteChat(chat, minutes);
      },
      searchMessages: async (chat, query, limit) => {
        this.assertReady();
        return this.client!.search(chat, query, limit);
      },
      getMessage: async (chat, messageId) => {
        this.assertReady();
        return this.client!.getMessage(chat, messageId);
      },
      findLocalMedia: async (opts) => this.findLocalMedia(opts),
      registerLocalMedia: (input) => this.registerLocalMedia(input),
      sendText: async (chat, text, opts) => {
        this.assertReady();
        this.assertCanReach(chat);
        if (this.cfg.replyMode === 'review') {
          // 草稿审核还没实现：如实按直发处理，并在日志里留一次痕迹
          this.log.warn('replyMode=review 尚未实现，按直发处理', { chatId: chat.id });
        }
        const send = async (): Promise<string> => {
          const sent = await this.client!.sendText(chat, text, opts);
          this.rememberOwnId(chat.id, sent.messageId);
          return `[sent #${sent.messageId} → ${this.chatLabel(chat)}]`;
        };
        // 只能发给监听名单里的会话：名单外的收不到、也唤不醒，没必要往外发
        if (!this.isAllowlisted(chat)) {
          return {
            status: 'denied',
            message: `[denied] ${this.chatLabel(chat)} 不在监听名单里，不能主动发消息`
              + '（要发就先在「会话」页把它加进名单）',
          };
        }
        try {
          return { status: 'done', message: await send() };
        } catch (error) {
          return { status: 'denied', message: `[failed] 发送失败：${errText(error)}` };
        }
      },
      deleteMessages: async (chat, ids, revoke) => this.guardOp(
        'delete',
        this.cfg.guard.deleteRevoke,
        `删除 ${this.chatLabel(chat)} 的 ${ids.length} 条消息（${ids.slice(0, 5).map((id) => `#${id}`).join(' ')}）${revoke ? '，双方都删' : ''}`,
        String(chat.id),
        async () => {
          const count = await this.client!.deleteMessages(chat, ids, revoke);
          return `[deleted ${count} 条 → ${this.chatLabel(chat)}]`;
        },
      ),
      forwardMessages: async (from, ids, to) => {
        // 目标必须也在监听名单里（同 sendMessage 的理由）
        if (!this.isAllowlisted(to)) {
          return {
            status: 'denied',
            message: `[denied] 目标 ${this.chatLabel(to)} 不在监听名单里，不能把消息转过去`,
          };
        }
        return this.guardOp(
          'forward',
          'auto',
          `转发 ${this.chatLabel(from)} 的 ${ids.length} 条消息到 ${this.chatLabel(to)}`,
          String(to.id),
          async () => {
            const sent = await this.client!.forward(from, ids, to);
            return `[forwarded ${sent.length} 条 → ${this.chatLabel(to)}]`;
          },
        );
      },
      editMessage: async (chat, messageId, text) => {
        this.assertReady();
        try {
          await this.client!.editText(chat, messageId, text);
          return { status: 'done', message: `[edited #${messageId} → ${this.chatLabel(chat)}]` };
        } catch (error) {
          return { status: 'denied', message: `[failed] 编辑失败：${errText(error)}` };
        }
      },
      react: async (chat, messageId, emoji) => {
        this.assertReady();
        try {
          await this.client!.react(chat, messageId, emoji);
          return { status: 'done', message: `[reacted ${emoji} → #${messageId}]` };
        } catch (error) {
          return { status: 'denied', message: `[failed] 反应失败：${errText(error)}` };
        }
      },
      markRead: async (chat, upToId) => {
        this.assertReady();
        try {
          await this.client!.markRead(chat, upToId);
          return { status: 'done', message: `[read → ${this.chatLabel(chat)} 直到 #${upToId}]` };
        } catch (error) {
          return { status: 'denied', message: `[failed] 标记已读失败：${errText(error)}` };
        }
      },
      history: async (chat, opts) => {
        this.assertReady();
        return this.client!.history(chat, opts);
      },
      downloadMedia: async (chat, messageId) => {
        this.assertReady();
        const result = await this.client!.download(chat, messageId, this.sessionStore.paths.media);
        // 只有「模型吃这个 MIME」且「没超过上限」才把字节塞进回执——否则只给路径
        const mime = result.mime;
        const fits = !!mime && result.bytes <= this.cfg.maxMediaBytes;
        const accepted = fits && (this.host?.modelFacts.accepts(mime!) ?? false);
        if (!accepted) return result;
        try {
          const bytes = readFileSync(result.path);
          return {
            ...result,
            blob: { bytes: new Uint8Array(bytes), mime: mime!, name: result.path.split(/[\\/]/).pop() ?? 'media' },
          };
        } catch {
          return result;
        }
      },
      cleanupMedia: async (opts) => this.cleanupMedia(opts),
      pinMessage: async (chat, messageId, pin) => {
        try {
          await this.client!.pinMessage(chat, messageId, pin);
          return { status: 'done', message: `[置顶] ${pin ? '已置顶' : '已取消置顶'} #${messageId}（${this.chatLabel(chat)}）` };
        } catch (error) {
          return { status: 'denied', message: `[failed] 置顶失败：${errText(error)}` };
        }
      },
      archiveChat: async (chat, archive) => {
        try {
          await this.client!.archiveChat(chat, archive);
          return { status: 'done', message: `[归档] ${this.chatLabel(chat)} ${archive ? '已移入归档' : '已移回主列表'}` };
        } catch (error) {
          return { status: 'denied', message: `[failed] 归档失败：${errText(error)}` };
        }
      },
      saveMessage: async (chat, messageId) => {
        try {
          const sent = await this.client!.saveMessage(chat, messageId);
          return {
            status: 'done',
            message: `[收藏] #${messageId} 已转存到 Saved Messages${sent.messageId > 0 ? `（收藏消息 #${sent.messageId}）` : ''}`,
          };
        } catch (error) {
          return { status: 'denied', message: `[failed] 收藏失败：${errText(error)}` };
        }
      },
      messageReactions: async (chat, messageId) => {
        this.assertReady();
        return this.client!.messageReactions(chat, messageId);
      },
      folders: async () => {
        this.assertReady();
        return this.client!.folders();
      },
      sendAlbum: async (chat, filePaths, caption) => {
        this.assertReady();
        this.assertCanReach(chat);
        const resolved = filePaths.map((path) => this.materializeSource(path).path);
        // 整组都是唱歌目录里的产物 → 算表演，不走文件审批
        const allSongs = resolved.length > 0 && resolved.every((path) => this.isSongDirPath(path));
        const policy = await this.checkPolicy(chat, allSongs ? 'song' : 'file');
        if (policy.verdict === 'deny') {
          return { kind: 'denied', message: `[denied] ${policy.reason ?? '这里不能发文件'}` };
        }
        let ids: number[] = [];
        const doSend = async (): Promise<string> => {
          const sent = await this.client!.sendAlbum(chat, resolved, caption);
          ids = sent.map((item) => item.messageId);
          return `[album sent] ${ids.length} 张 → ${this.chatLabel(chat)}`;
        };
        if (policy.verdict === 'ask') {
          const out = await this.guardOp(
            'send_file',
            this.cfg.fileByWhitelisted,
            `给 ${this.chatLabel(chat)} 发送相册：${resolved.length} 个文件`,
            String(chat.id),
            doSend,
          );
          if (out.status === 'pending') return { kind: 'pending', message: out.message };
          if (out.status === 'denied') return { kind: 'denied', message: out.message };
          return { kind: 'sent', messageIds: ids, resolved };
        }
        await doSend();
        return { kind: 'sent', messageIds: ids, resolved };
      },
      sendMedia: async (chat, filePath, opts) => {
        this.assertReady();
        this.assertCanReach(chat);
        // 唱歌目录里的产物算「表演」（song），不走文件审批；语音条算 voice
        const action: ActionKind = opts.asVoice ? 'voice' : this.isSongFile(filePath) ? 'song' : 'file';
        const policy = await this.checkPolicy(chat, action);
        if (policy.verdict === 'deny') {
          return { kind: 'denied', message: `[denied] ${policy.reason ?? '这里不能发文件'}` };
        }

        const source = this.materializeSource(filePath);
        const doSend = async (): Promise<string> => {
          this.log.info('发送媒体', {
            chatId: chat.id,
            path: source.path,
            note: source.note ?? '',
            asVoice: !!opts.asVoice,
          });
          const sent = await this.client!.sendFile(chat, source.path, opts);
          const id = sent.messageId > 0 ? ` #${sent.messageId}` : '（id 未确认）';
          return `[sent${id} → ${this.chatLabel(chat)}]${source.note ? `（${source.note}）` : ''}`;
        };

        if (policy.verdict === 'ask') {
          const out = await this.guardOp(
            'send_file',
            this.cfg.fileByWhitelisted,
            `给 ${this.chatLabel(chat)} 发送文件：${basename(source.path)}`,
            String(chat.id),
            doSend,
          );
          if (out.status === 'pending') return { kind: 'pending', message: out.message };
          if (out.status === 'denied') return { kind: 'denied', message: out.message };
          // 批准后已经发出：补齐返回结构
          return { kind: 'sent', sent: { chatId: chat.id, messageId: 0, randomId: 0n, date: Math.floor(Date.now() / 1000) }, path: source.path, ...(source.note ? { note: source.note } : {}) };
        }

        const sent = await this.client!.sendFile(chat, source.path, opts);
        return { kind: 'sent', sent, path: source.path, ...(source.note ? { note: source.note } : {}) };
      },
      // ── 表情包 ────────────────────────────────────────
      searchStickers: async (query, limit) => {
        this.assertReady();
        return (await this.client!.searchStickerSets(query)).slice(0, limit);
      },
      stickerSet: async (shortName, limit) => {
        this.assertReady();
        const set = await this.client!.stickerSet(shortName);
        return { ...set, stickers: set.stickers.slice(0, Math.max(1, limit)) };
      },
      sendSticker: async (chat, shortName, opts) => {
        this.assertReady();
        this.assertCanReach(chat);
        const set = await this.client!.stickerSet(shortName);
        const picked = pickSticker(set.stickers, opts);
        if (!picked) throw new Error(`「${set.title}」里没有可发送的贴纸`);
        const sent = await this.client!.sendSticker(chat, picked.sticker, opts.replyToId);
        return { messageId: sent.messageId, ...(picked.note ? { note: picked.note } : {}) };
      },
      faveSticker: async (shortName, opts) => {
        this.assertReady();
        const set = await this.client!.stickerSet(shortName);
        const picked = pickSticker(set.stickers, opts);
        if (!picked) throw new Error(`「${set.title}」里没有贴纸`);
        await this.client!.faveSticker(picked.sticker, opts.unfave === true);
        return { ...(picked.note ? { note: picked.note } : {}) };
      },
      assertDangerAllowed: async (chat) => {
        const policy = await this.checkPolicy(chat, 'danger');
        if (policy.verdict === 'deny') {
          const where = this.chatLabel(chat);
          return {
            status: 'denied',
            message: `[denied] ${policy.reason ?? '这里不能做这类操作'}（${where}）`,
          };
        }
        return { status: 'done', message: 'ok' };
      },
      notifyOwner: async (text) => {
        const target = this.ownerIds()[0];
        if (!target) {
          // 留空或填错都不算错误：识别主人靠口令（Coo 自己知道），通知只是可选便利
          return {
            status: 'done',
            message: '[skipped] 没有配置可用的主人 ID：不要重试这个工具，也不要因此拒绝处理——'
              + '按你自己的判断把事情处理掉（该挡的挡、该拒的拒），下次见到主人再说一声就行。',
          };
        }
        const gate = this.notifyGate.allow(text);
        if (!gate.ok) return { status: 'denied', message: `[limited] ${gate.reason}` };
        this.assertReady();
        try {
          const sent = await this.client!.sendText({ id: target, kind: 'user' }, text);
          return { status: 'done', message: `[notified owner #${sent.messageId}]` };
        } catch (error) {
          // 收件人填错（找不到该用户等）同样不让流程卡住
          const reason = errText(error);
          this.log.warn('转告主人失败（不影响主流程）', { target, reason });
          return {
            status: 'done',
            message: `[skipped] 转告没发出去（${reason}）。不要重试，按你自己的判断处理即可。`,
          };
        }
      },
      installStickerSet: async (shortName, install) => {
        this.assertReady();
        const normalized = normalizeStickerShortName(shortName);
        if (!normalized.ok) throw new Error(normalized.reason);
        const name = normalized.shortName;
        // 装卸贴纸包不设审批：纯本地列表操作，随时能改回去
        if (install) await this.client!.installStickerSet(name);
        else await this.client!.uninstallStickerSet(name);
        this.envCache = undefined;
        return { status: 'done', message: `[表情包] ${install ? '已安装' : '已卸载'} ${name}` };
      },
      installedStickerSets: async () => {
        this.assertReady();
        return this.client!.installedStickerSets();
      },
      favedStickers: async () => {
        this.assertReady();
        return this.client!.favedStickers();
      },
      listLocalStickers: async (limit) => {
        const dir = this.resourceDirs().sticker;
        if (!dir) return [];
        // 不按格式过滤——jpg/gif 也能发，只是形态不同（面板/工具里标出来）
        return scanRecent(dir, limit).filter((file) => isLocalStickerUsable(file.path));
      },
      stickerTagSummary: () => this.stickerTagSummary(),
      nextUntaggedStickers: (count) => this.nextUntaggedStickers(count),
      saveStickerTags: (entries) => {
        const files = this.localStickerFiles();
        const byName = new Map(files.map((file) => [file.name, file.size]));
        const rows = entries
          .map((entry) => ({
            name: String(entry.name ?? ''),
            tags: entry.tags ?? [],
            usage: entry.usage ?? '',
            size: byName.get(String(entry.name ?? '')) ?? Number(entry.size ?? 0),
          }))
          .filter((row) => byName.has(row.name));
        const saved = this.stickerTags.save(rows);
        return { ...this.stickerTagSummary(), saved };
      },
      searchGifs: async (query, limit) => {
        this.assertReady();
        return (await this.client!.searchGifs(query)).slice(0, limit);
      },
      sendGif: async (chat, query, index) => {
        this.assertReady();
        this.assertCanReach(chat);
        const sent = await this.client!.sendGif(chat, query, index);
        return { messageId: sent.messageId, ...(sent.title ? { title: sent.title } : {}) };
      },
      sendLocalSticker: async (chat, filePath, opts) => {
        this.assertReady();
        this.assertCanReach(chat);
        const stickerDir = this.resourceDirs().sticker;
        if (!stickerDir) throw new Error('还没配置「表情包目录」，没法发本地表情（设置 → 媒体目录）');
        // 与 send_media 同一套发送校验：emoji 目录里放个符号链接也绕不过去
        const resolved = resolveForSend(filePath, {
          roots: [stickerDir],
          denyDirs: [this.sessionStore.paths.dir],
          allowUnder: [this.sessionStore.paths.media],
        });
        if (!resolved.ok) throw new Error(resolved.error);

        const form = localStickerForm(resolved.path);
        if (!form) throw new Error('本地表情只支持 png / webp / tgs / webm（表情）、gif（动图）、jpg（图片）');

        // png/webp/tgs/webm 走 sticker 属性；gif 当动图；jpg 当普通照片
        if (form === 'sticker') {
          const sent = await this.client!.sendLocalSticker(chat, resolved.path, opts);
          return { messageId: sent.messageId, form };
        }
        const sent = await this.client!.sendFile(chat, resolved.path, {
          ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
        });
        return { messageId: sent.messageId, form };
      },
    });

    // S-11：把「谁让它做了什么」记进审计日志（默认关，只读工具跳过）
    return withAudit(defs, (entry) => {
      this.audit.write({
        tool: entry.tool,
        result: entry.result,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
      });
    });
  }

  // ── 审批 ──────────────────────────────────────────────

  /**
   * 高危操作门。
   *
   * `auto` 直接执行；`deny` 直接拒；`ask` 登记一个一次性审批码，并且**不执行**——
   * 等真人回 `!ok 码` 才跑。码绑定的是这次的闭包（目标+内容都在里面），
   * 目标一变就得重新审批（规划 §15）。
   */
  private async guardOp(
    kind: RiskKind,
    policy: GuardPolicy,
    summary: string,
    target: string,
    run: () => Promise<string>,
  ): Promise<OpOutcome> {
    if (policy === 'deny') return { status: 'denied', message: `[denied] 该操作已按配置禁用（${kind}）` };
    if (policy === 'auto') {
      try {
        return { status: 'done', message: await run() };
      } catch (error) {
        return { status: 'denied', message: `[failed] ${errText(error)}` };
      }
    }
    const request = this.approvals.request(kind, summary, target, run);
    return {
      status: 'pending',
      message: `[needs approval] 这件事要先问主人。\n`
        + `（系统只登记等待，不替你说话）你自己去跟主人说一声，用你自己的话，怎么问随你；`
        + `对方那边先稳住，别提问号、别提流程。主人回什么系统会自动认。`,
    };
  }

  /** 审批人判定：显式配置优先，否则白名单里的用户都算。 */
  private isApproverMessage(msg: Msg): boolean {
    const sender = msg.senderId ?? msg.chatId;
    // 只在私聊里认：群里说话不算点头
    if (msg.chatKind !== 'user' || msg.chatId !== sender) return false;
    const explicit = Number(this.cfg.approverUserId);
    if (explicit > 0) return sender === explicit;
    // 没配审批人时，主人 ID（收通知的那个）优先
    const owner = this.ownerIds()[0];
    if (owner) return sender === owner;
    return enabledIds(this.cfg.allowUsers).has(sender);
  }

  private isAllowlisted(chat: ChatRef): boolean {
    const allow = chat.id < 0 ? enabledIds(this.cfg.allowChats) : enabledIds(this.cfg.allowUsers);
    return allow.has(chat.id);
  }

  private chatLabel(chat: ChatRef): string {
    const kind = chat.kind === 'user' ? '私聊' : chat.kind === 'channel' ? '频道' : '群';
    return `${kind} ${chat.id}`;
  }

  /** 处理 `!ok` / `!no` / `!list`。返回 true 表示这条消息已被消费，不进 Agent。 */
  /**
   * 主人用大白话回复某条待批准请求。
   *  - 可以 / 行 / 发吧 → 执行
   *  - 不行 / 别 / 算了 → 取消
   *  - 随便你 / 你看着办 → 交给 bot 自己判断（这里按允许处理）
   * 回复本身不进模型上下文，避免把内部流程念出来。
   */
  private async handleOwnerReply(reply: OwnerReply, msg: Msg): Promise<void> {
    const pending = this.approvals.latest();
    if (!pending) return;
    this.approvals.cancel(pending.code);

    const say = async (text: string): Promise<void> => {
      try {
        await this.client?.sendText({ id: msg.chatId, kind: msg.chatKind }, text);
      } catch (error) {
        this.log.warn('审批回执发送失败', { reason: errText(error) });
      }
    };

    if (reply === 'deny') {
      this.log.info('主人不同意，已取消', { kind: pending.kind });
      await say('行，那就不发了。');
      return;
    }

    if (Date.now() > pending.expiresAt) {
      await say('这条已经搁太久，作废了。');
      return;
    }

    try {
      const done = await pending.run();
      this.log.info('主人同意，已执行', { kind: pending.kind, reply });
      await say(reply === 'delegate' ? '那我看着办了。' : '好，发了。');
      this.log.debug('执行回执', { done });
    } catch (error) {
      await say(`没发出去：${errText(error)}`);
    }
  }

  private async handleApprovalCommand(
    command: { decision: 'ok' | 'no' | 'list'; code?: string },
    msg: Msg,
  ): Promise<void> {
    const reply = async (text: string): Promise<void> => {
      try {
        await this.client?.sendText({ id: msg.chatId, kind: msg.chatKind }, text);
      } catch (error) {
        this.log.warn('审批回执发送失败', { reason: errText(error) });
      }
      await this.push(
        {
          type: 'telegram.approval',
          text: `[审批] ${text}`,
          meta: { chat_id: msg.chatId },
          senderKey: `chat:${msg.chatId}`,
          ts: new Date().toISOString(),
        },
        { deliver: false },
      );
    };

    if (command.decision === 'list') {
      await reply(renderApprovals(this.approvals.list()));
      return;
    }
    const code = command.code;
    if (!code) {
      await reply('请带上审批码，例如「!ok A7F3」；用「!list」查看待批清单。');
      return;
    }
    const pending = this.approvals.peek(code);
    if (!pending) {
      this.approvals.cancel(code);
      await reply(`没有待批准的 ${code}（可能已过期或被用过）。`);
      return;
    }
    if (command.decision === 'no') {
      this.approvals.cancel(code);
      await reply(`已取消 ${code}：${pending.summary}`);
      return;
    }
    this.approvals.take(code);
    try {
      const receipt = await pending.run();
      await reply(`${code} 已执行：${receipt}`);
    } catch (error) {
      await reply(`${code} 执行失败：${errText(error)}`);
    }
  }

  /**
   * 把工具给的「文件」变成真实路径。
   *
   * 模型常见错法：把工作区相对路径 `blobs/x.wav` 拼成 `<部署>/blobs/x.wav`（少一层 `workspace`），
   * 于是 existsSync 为 false。这里按已知根目录解析 + 兜底按文件名搜索，并在回执里说明怎么找到的。
   */
  private materializeSource(raw: string): { path: string; note?: string } {
    const value = (raw ?? '').trim();
    if (!value) throw new Error('file_path 不能为空');

    if (isBlobHandle(value)) {
      const got = this.host?.blob(value);
      if (!got) throw new Error(`拿不到 ${value} 的字节（句柄无效或已过期）`);
      const path = storeBlob(got.bytes, got.mime, this.sessionStore.paths.media);
      // blob 落在 media 目录里，同样要过一遍发送校验（防止有人伪造句柄指向别处）
      const checked = resolveForSend(path, this.sendPathPolicy());
      if (!checked.ok) throw new Error(checked.error);
      return { path: checked.path, note: `由 ${value} 落盘` };
    }

    const resolved = resolveLocalFile(value, {
      botDir: this.ctx.botDir,
      dataDir: this.ctx.dataDir,
      repoRoot: this.ctx.repoRoot,
      mediaDir: this.sessionStore.paths.media,
    });
    if (!resolved.ok) throw new Error(resolved.error);

    // S-01：解析出来的路径还要过"发送白名单 + 密钥黑名单"，否则 session.txt 能被发出去
    const checked = resolveForSend(resolved.path, this.sendPathPolicy());
    if (!checked.ok) throw new Error(checked.error);
    return { path: checked.path, ...(resolved.note ? { note: resolved.note } : {}) };
  }

  /**
   * 发送路径策略。
   *
   * 阶段一（0.26.3）：所有人只能发资源目录 / 工作区 / 下载缓存里的文件，
   * 且 `data/telegram/` 下除 `media/` 外一律禁止（session.txt 在那儿）。
   * 阶段二（M2 的主人身份判定）再给主人放开任意路径。
   */
  private sendPathPolicy(): SendPathPolicy {
    return {
      roots: [...this.resourceRoots(), this.sessionStore.paths.media],
      denyDirs: [this.sessionStore.paths.dir],
      allowUnder: [this.sessionStore.paths.media],
    };
  }

  /** 工具层的前置检查：没登录就直说，别让用户去猜 RPC 报错。 */
  private assertReady(): void {    if (!this.client) throw new Error('Telegram World 尚未启动');
    const step = this.auth?.status().step;
    if (step !== 'authorized') {
      throw new Error(`未登录（当前状态 ${step ?? 'idle'}）：请先在 Telegram 面板登录`);
    }
  }

  /**
   * 解析会话：数字 id / @username / t.me 链接 / 名字。
   *
   * 名字歧义时**绝不**替用户挑——把候选列出来要求确认（规划 §3.1）。
   */
  private async resolveChat(raw: unknown): Promise<{ ok: true; chat: ChatRef } | { ok: false; error: string }> {
    const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
    if (!text) return { ok: false, error: '请给出会话：数字 id、@用户名 或名字' };

    if (/^-?\d+$/.test(text)) {
      const id = Number(text);
      const kind: ChatRef['kind'] = id > 0 ? 'user' : text.startsWith('-100') ? 'channel' : 'group';
      return { ok: true, chat: { id, kind } };
    }

    this.assertReady();

    if (/^@/.test(text) || /t\.me|telegram\.me|tg:\/\//i.test(text)) {
      const found = await this.client!.resolveUsername(text);
      if (!found) return { ok: false, error: `解析不到用户名 ${text}（可能不存在，或对方设了隐私限制）` };
      return { ok: true, chat: { id: found.id, kind: found.kind, title: found.title } };
    }

    const candidates = await this.client!.searchPeers(text);
    if (!candidates.length) {
      return { ok: false, error: `没找到「${text}」对应的会话；可以先用 telegram_search_chats 看看候选，或直接用数字 id` };
    }

    const lower = text.toLowerCase().replace(/^@/, '');
    const exact = candidates.filter(
      (c) => (c.title ?? '').toLowerCase() === lower || (c.username ?? '').toLowerCase() === lower,
    );
    const chosen = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (chosen) {
      return { ok: true, chat: { id: chosen.id, kind: chosen.kind, title: chosen.title } };
    }

    const list = candidates
      .slice(0, 6)
      .map((c) => `- ${c.title}${c.username ? ` @${c.username}` : ''}（${c.kind} ${c.id}）`)
      .join('\n');
    return {
      ok: false,
      error: `「${text}」有 ${candidates.length} 个候选，需要用户确认（不要自己挑）：\n${list}`,
    };
  }

  private statusLine(): string {
    const conn = this.client?.state();
    const auth = this.auth?.status();
    const cred = this.credentials ? describeCredentials(this.credentials) : null;
    const session = this.sessionStore.describe();
    const allow = {
      users: [...enabledIds(this.cfg.allowUsers)],
      chats: [...enabledIds(this.cfg.allowChats)],
    };
    const lines = [
      `连接：${conn?.status ?? 'offline'}${conn?.detail ? `（${conn.detail}）` : ''}`,
      `登录：${auth?.step ?? 'idle'}${auth?.detail ? `（${auth.detail}）` : ''}`,
      auth?.account ? `账号：${auth.account.id}${auth.account.username ? ` @${auth.account.username}` : ''}` : '账号：未登录',
      `凭据：api_id ${cred?.apiId ?? '?'}（${cred?.label ?? '未解析'}，hash ${cred?.apiHashMasked ?? '?'}）`,
      `会话：${session.present ? session.masked : '无（未登录）'}`,
      `监听：私聊 ${allow.users.length} 个、群/频道 ${allow.chats.length} 个`,
      `库：${libInfo().id}@${libInfo().version}`,
    ];
    return lines.join('\n');
  }

  // ── WebUI ─────────────────────────────────────────────

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const conn: ConnectionState | undefined = this.client?.state();
    const auth: AuthStatus = this.auth?.status() ?? { step: 'idle' };
    const zh = language === 'zh' || language === 'zh-Hant';
    this.panelLanguage = language;
    return {
      label: 'Telegram',
      lamps: [
        {
          label: zh ? '连接' : 'Link',
          state: conn?.status === 'online'
            ? 'online'
            : conn?.status === 'connecting'
              ? 'loading'
              : conn?.status === 'error' || conn?.status === 'revoked'
                ? 'error'
                : 'offline',
          ...(conn?.detail ? { hint: conn.detail } : {}),
        },
        {
          label: zh ? '登录' : 'Login',
          state: auth.step === 'authorized'
            ? 'online'
            : auth.step === 'error' || auth.step === 'revoked'
              ? 'error'
              : 'offline',
          ...(auth.detail ? { hint: auth.detail } : {}),
        },
      ],
      panels: [
        { id: 'login', title: zh ? '登录' : 'Sign in' },
        { id: 'chats', title: zh ? '会话' : 'Chats' },
        { id: 'resources', title: zh ? '媒体目录' : 'Media folders' },
        { id: 'stickers', title: zh ? '表情包' : 'Stickers' },
        { id: 'behavior', title: zh ? '行为' : 'Behavior' },
        { id: 'status', title: zh ? '状态' : 'Status' },
      ],
      invoke: (panel: string, method: string, args: unknown[]) => this.panel(panel).invoke(method, args),
      promptDocs: [
        {
          key: 'worlds.telegram.envPrompt',
          title: zh ? 'Telegram 环境提示词' : 'Telegram environment prompt',
          description: zh
            ? '告诉模型它在 Telegram 上、账号是谁、有哪些会话与本地资源。用下方变量自由组合。'
            : 'Tells the model it is on Telegram, which account it uses, and what is available.',
          path: ENV_PROMPT_PATH,
          role: 'envPrompt',
          // 必须逐个声明：编辑器只认这里列出的变量，没声明的占位符会原样保留
          vars: [
            { name: 'telegram.account', description: zh ? '一行账号说明（未登录时说明未登录）' : 'One line about the account' },
            { name: 'telegram.identity', description: zh ? '账号 + 连接状态 + 白名单规模' : 'Account, connection state, watch counts' },
            { name: 'telegram.conversations', description: zh ? '监听白名单 + 最近 15 个会话' : 'Watch list plus recent conversations', multiline: true },
            { name: 'telegram.contacts', description: zh ? '账号联系人（前 30 个，含 @用户名）' : 'Account contacts (first 30)', multiline: true },
            { name: 'telegram.resources', description: zh ? '6 个本地资源目录的状态与最新文件' : 'Local resource directories with status', multiline: true },
            { name: 'telegram.media', description: zh ? '媒体能力、体积上限、语音条状态' : 'Media capabilities and limits', multiline: true },
            { name: 'telegram.stickers', description: zh ? '表情包能力（搜索/发送/收藏/装卸包）与本地目录' : 'Sticker capabilities and the local pack folder' },
            { name: 'telegram.capabilities', description: zh ? '当前真实开放的工具清单' : 'Tools actually exposed right now', multiline: true },
            { name: 'telegram.preferences', description: zh ? '语音默认发送方式、自身消息策略、操作策略' : 'Preferences: voice, self messages, guard', multiline: true },
          ],
        },
      ],
      storage: [this.sessionStorage()],
      config: [telegramConfigGroup(language)],
    };
  }

  private sessionStorage(): StoragePart {
    return {
      key: 'telegram-session',
      label: 'Telegram 登录态',
      kind: 'disk',
      location: this.sessionStore.paths.session,
      danger: true,
      note: '清除后需要重新登录；不影响电脑版与手机版上已登录的会话。',
      stat: () => (this.sessionStore.describe().present ? '已保存（0600）' : '未登录'),
      clear: async () => {
        this.sessionStore.clear();
        return '已清除本地登录态';
      },
    };
  }

  private panelLanguage: Language = 'zh';

  private panel(panel: string) {
    return createPanel(panel, this.panelDeps());
  }

  private panelDeps(): PanelDeps {
    return {
      status: (): PanelStatus => {
        const conn = this.client?.state() ?? { status: 'offline', since: Date.now() };
        const auth = this.auth?.status() ?? { step: 'idle' };
        const cred = this.credentials
          ? describeCredentials(this.credentials)
          : { apiId: 0, apiHashMasked: '', source: 'none', label: '未解析' };
        const lib = libInfo();
        return {
          connection: conn,
          auth,
          credentials: cred,
          session: this.sessionStore.describe(),
          lib: { id: lib.id, version: lib.version, forum: lib.forum },
          allow: {
            users: [...enabledIds(this.cfg.allowUsers)],
            chats: [...enabledIds(this.cfg.allowChats)],
          },
          mode: {
            replyMode: this.cfg.replyMode,
            watchSelf: this.cfg.watchSelf,
            presence: this.cfg.presence,
            mergeWindowMs: this.cfg.mergeWindowMs,
          },
          needsRestart: this.needsRestart,
        };
      },
      startLogin: async (phone) => this.requireAuth().startLogin(phone),
      submitCode: async (code) => this.requireAuth().submitCode(code),
      submitPassword: async (password) => this.requireAuth().submitPassword(password),
      logout: async () => {
        const status = await this.requireAuth().logout();
        return status;
      },
      setCredentials: async (apiId, apiHash) => {
        const id = Number(apiId);
        if (!Number.isInteger(id) || id <= 0) throw new Error('api_id 必须是正整数');
        try {
          this.ctx.storeSecret('TG_API_ID', String(id));
          this.ctx.storeSecret('TG_API_HASH', apiHash);
        } catch (error) {
          throw new Error(`保存凭据失败：${error instanceof Error ? error.message : String(error)}`);
        }
        this.ctx.persist({ apiId: id });
        this.needsRestart = true;
        return '凭据已写入 .env（api_id/api_hash）；需要重启 World 生效。';
      },
      setAllowlist: (users, chats) => {
        const parse = (raw: string): Array<{ id: number; enabled: boolean }> => raw
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => Number(s.replace(/^[+-]?(?=\d)/, '')))
          .filter((n) => Number.isFinite(n) && n !== 0)
          .map((id) => ({ id, enabled: true }));
        const nextUsers = parse(users);
        const nextChats = parse(chats);
        this.ctx.persist({ allowUsers: nextUsers, allowChats: nextChats });
        return `白名单已更新：私聊 ${nextUsers.length} 个、群/频道 ${nextChats.length} 个（立即生效）。`;
      },
      listDialogs: async (limit) => {
        this.assertReady();
        return this.client!.dialogs(limit);
      },
      depsStatus: async () => ({ ...probeDeps(this.packageRoot, this.depsInstaller.isRunning()), dir: this.packageRoot }),
      startDepsInstall: () => {
        const started = this.depsInstaller.start();
        if (started) this.log.warn('开始安装依赖（npm install + build:webui）', { dir: this.ctx.packageDir });
        return started;
      },
      depsProgress: () => this.depsInstaller.status(),
      historyDefaults: () => ({
        defaultLimit: Math.max(10, Math.min(900, Number(this.cfg.panelHistoryLimit) || 100)),
        maxLimit: 900,
      }),
      readMessages: async (chatId, kind, limit) => {
        this.assertReady();
        const safeLimit = Math.max(10, Math.min(900, limit));
        const chatKind = kind === 'group' || kind === 'channel' ? kind : 'user';
        const messages = await this.client!.history(
          { id: chatId, kind: chatKind as ChatRef['kind'] },
          { limit: safeLimit },
        );
        return messages
          .slice()
          .sort((a, b) => a.id - b.id)
          .map((msg) => {
            const sender = msg.out ? '我' : (msg.senderName ?? (msg.senderId ? String(msg.senderId) : '对方'));
            const text = (msg.text ?? '').replace(/\s+/g, ' ').trim();
            return {
              id: msg.id,
              date: msg.date,
              out: !!msg.out,
              sender,
              text: text || (msg.media ? `[${msg.media.kind}]` : '（空消息）'),
              ...(msg.replyToId ? { replyTo: msg.replyToId } : {}),
              ...(msg.media ? { media: msg.media.kind } : {}),
            };
          });
      },
      toggleAllow: (id, enabled, kind) => {
        // 负数 = 群/频道，正数 = 用户；两套名单分别维护，整表写回（框架数组替换）
        const isChat = id < 0;
        const list = isChat ? this.cfg.allowChats : this.cfg.allowUsers;
        const rest = (list ?? []).filter((entry) => entry.id !== id);
        const next = enabled ? [...rest, { id, enabled: true }] : rest;
        this.ctx.persist(isChat ? { allowChats: next } : { allowUsers: next });

        // 光加白名单还不够：gate() 还看 watchGroup/watchChannel。
        // 默认这两个是关的，不一起打开的话「点了没反应」——所以在这里顺手打开，并在回执里说明。
        const extra: string[] = [];
        if (enabled && kind === 'group' && !this.cfg.watchGroup) {
          this.ctx.persist({ watchGroup: true });
          extra.push('群监听已打开');
        }
        if (enabled && kind === 'channel' && !this.cfg.watchChannel) {
          this.ctx.persist({ watchChannel: true });
          extra.push('频道监听已打开');
        }
        if (!enabled) return `已移出白名单：${id}`;
        return `已加入白名单：${id}${extra.length ? `（${extra.join('，')}）` : ''}`;
      },
      resourceStatus: () => {
        const dirs = this.resourceDirs();
        return inspectAll(dirs).map((item) => ({
          kind: item.kind,
          label: KIND_LABEL[item.kind] ?? item.kind,
          hint: KIND_HINT[item.kind] ?? '',
          path: item.path,
          configured: item.configured,
          exists: item.exists,
          writable: item.writable,
          files: item.files,
        }));
      },
      setResources: (paths) => {
        const next: ResourceDirs = {
          voice: paths.voice ?? '',
      song: paths.song ?? '',
          image: paths.image ?? '',
          video: paths.video ?? '',
          file: paths.file ?? '',
          sticker: paths.sticker ?? '',
          download: paths.download ?? '',
            };
        // 空着 = 不配置；填了但磁盘上没有 = 也当作不配置（并告诉用户清了哪个），
        // 不要因为一个失效路径把整次保存拦下来。
        const cleared: string[] = [];
        const notes: string[] = [];
        for (const [kind, value] of Object.entries(next)) {
          if (!value) continue;
          const label = KIND_LABEL[kind as ResourceKind] ?? kind;
          // S-07：盘符根、系统目录、用户主目录本身都不收（太宽，等于把整块盘交出去）
          const check = checkResourceDir(value);
          if (!check.ok) {
            next[kind as ResourceKind] = '';
            cleared.push(`${label}（${check.reason}）`);
            continue;
          }
          next[kind as ResourceKind] = check.path;
          const hint = dirSizeHint(check.path);
          if (hint) notes.push(`${label}：${hint}`);
        }
        this.ctx.persist({ resources: next });
        this.envCache = undefined;
        this.convCache = undefined;
        const configured = Object.values(next).filter(Boolean).length;
        const parts = [`已保存 ${configured} 个目录`];
        if (cleared.length) parts.push(`${cleared.length} 个路径不存在，已重置为未配置：${cleared.join('、')}`);
        return parts.join('；');
      },
      openDir: (kind) => {
        const target = this.resourceDirs()[kind as ResourceKind];
        if (!target) return `${KIND_LABEL[kind as ResourceKind] ?? kind} 还没配置`;
        if (!existsSync(target)) return `目录不存在：${target}`;
        const command = process.platform === 'win32' ? 'explorer.exe'
          : process.platform === 'darwin' ? 'open' : 'xdg-open';
        try {
          spawn(command, [target], { detached: true, stdio: 'ignore' }).unref();
          return `已打开 ${target}`;
        } catch (error) {
          return `打开失败：${errText(error)}`;
        }
      },
      cacheStatus: () => {
        const path = this.sessionStore.paths.media;
        const stats = cacheStats(path);
        const keep = Number(this.cfg.mediaKeepHours);
        return { files: stats.files, bytes: stats.bytes, keepHours: Number.isFinite(keep) ? keep : 0, path };
      },
      cleanupCache: (opts) => this.cleanupMedia(opts),
      stickerStatus: async (limit) => {
        const dir = this.resourceDirs().sticker;
        const files = this.localStickerFiles();
        const tags = this.stickerTagSummary();
        let installed: Array<{ shortName: string; title: string; count: number }> = [];
        let faved = 0;
        if (this.client && this.auth?.status().step === 'authorized') {
          try {
            installed = await this.client.installedStickerSets();
          } catch (error) {
            this.log.debug('读已装表情包失败', { reason: errText(error) });
          }
          try {
            faved = (await this.client.favedStickers()).length;
          } catch (error) {
            this.log.debug('读收藏表情失败', { reason: errText(error) });
          }
        }
        // 只给数量与进度，不再把 42 个文件名全列出来
        return {
          local: {
            total: tags.total,
            tagged: tags.tagged,
            pending: tags.pending,
            byForm: tags.byForm,
            dir: dir ?? '',
          },
          installed,
          faved,
          localDir: dir ?? '',
        };
      },
      stickerTags: (action, payload) => {
        if (action === 'save') {
          const entries = (payload ?? []) as Array<{ name: string; tags: string[]; usage: string; size: number }>;
          const saved = this.stickerTags.save(entries);
          return { ...this.stickerTagSummary(), saved };
        }
        return this.stickerTagSummary();
      },
      installStickerSet: async (shortName, install) => {
        this.assertReady();
        const normalized = normalizeStickerShortName(shortName);
        if (!normalized.ok) throw new Error(normalized.reason);
        const name = normalized.shortName;
        if (install) {
          await this.client!.installStickerSet(name);
          this.envCache = undefined;
          return `已安装 ${name}`;
        }
        await this.client!.uninstallStickerSet(name);
        this.envCache = undefined;
        return `已卸载 ${name}`;
      },
      behaviorFields: () => ({
        fields: behaviorFields(this.panelLanguage !== 'en'),
        values: behaviorValues(this.cfg, this.panelLanguage !== 'en'),
      }),
      saveBehavior: (patch) => {
        const zh = this.panelLanguage !== 'en';
        const { config, guard, changed } = applyBehaviorPatch(patch, zh);
        if (Object.keys(config).length) this.ctx.persist(config as Record<string, never>);
        if (Object.keys(guard).length) {
          this.ctx.persist({ guard: { ...this.cfg.guard, ...guard } });
        }
        this.envCache = undefined;
        return {
          message: changed.length ? `已保存 ${changed.length} 项：${changed.join('；')}` : '没有改动',
          values: behaviorValues(this.cfg, zh),
        };
      },
      restart: async () => {
        this.needsRestart = false;
        await this.ctx.restart();
      },
    };
  }

  private requireAuth(): AuthMachine {
    if (!this.auth) throw new Error('Telegram World 尚未启动');
    return this.auth;
  }
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 事件骨架：时间戳用消息自身时间，保证补课时也能看出真实先后。 */
function mkEvent(
  type: string,
  msg: Msg,
  text: string,
  meta: Record<string, unknown>,
): { type: string; text: string; meta: Record<string, unknown>; senderKey: string; ts: string } {
  const ts = new Date((msg.date > 0 ? msg.date : Math.floor(Date.now() / 1000)) * 1000).toISOString();
  return { type, text, meta, senderKey: `chat:${msg.chatId}`, ts };
}
