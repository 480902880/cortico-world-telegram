/**
 * WebUI 面板的数据面：`webUi().invoke` 的分发。
 *
 * 面板只能调这里列出的方法；所有返回值都是纯 JSON（不传任何库对象）。
 * 凭据与 session 只回掩码。
 */

import type { SettingField } from '../settings.ts';
import type { AuthStatus, DialogEntry } from '../mtproto/port.ts';

export interface PanelStatus {
  connection: { status: string; since: number; detail?: string };
  auth: AuthStatus;
  credentials: { apiId: number; apiHashMasked: string; source: string; label: string };
  session: { present: boolean; masked: string; bytes: number };
  lib: { id: string; version: string; forum: string | null };
  allow: { users: number[]; chats: number[] };
  mode: { replyMode: string; watchSelf: string; presence: string; mergeWindowMs: number };
  needsRestart: boolean;
}

export interface PanelDeps {
  status(): PanelStatus;
  startLogin(phone: string): Promise<AuthStatus>;
  submitCode(code: string): Promise<AuthStatus>;
  submitPassword(password: string): Promise<AuthStatus>;
  logout(): Promise<AuthStatus>;
  setCredentials(apiId: string, apiHash: string): Promise<string>;
  setAllowlist(users: string, chats: string): string;
  /** 账号的会话列表（好友 + 群 + 频道），用于点选白名单。 */
  listDialogs(limit: number): Promise<DialogEntry[]>;
  /** 把某个会话加入/移出唤醒白名单。 */
  toggleAllow(id: number, enabled: boolean, kind: string): string;
  /** 依赖自检（缺什么、能不能登录）。 */
  depsStatus(): Promise<{
    node: string;
    hasNodeModules: boolean;
    missing: string[];
    hasDist: boolean;
    ready: boolean;
    installing: boolean;
  }>;
  /** 一键安装依赖；true = 已开始。 */
  startDepsInstall(): boolean;
  /** 安装进度（面板轮询）。 */
  depsProgress(): {
    running: boolean;
    finished: boolean;
    ok: boolean;
    phase: string;
    lines: string[];
    error?: string;
  };
  /** 历史面板：默认条数与上限（上限 900，防卡顿）。 */
  historyDefaults(): { defaultLimit: number; maxLimit: number };
  /** 读某个会话最近 N 条消息（面板双击展开用）。 */
  readMessages(chatId: number, kind: string, limit: number): Promise<Array<{
    id: number;
    date: number;
    out: boolean;
    sender: string;
    text: string;
    replyTo?: number;
    media?: string;
  }>>;
  /** 7 个资源目录的实时状态。 */
  resourceStatus(): Array<{
    kind: string;
    label: string;
    path: string;
    configured: boolean;
    exists: boolean;
    writable: boolean;
    files: number;
  }>;
  /** 保存资源目录（整表写回）。 */
  setResources(paths: Record<string, string>): string;
  /** 用系统文件管理器打开某个资源目录。 */
  openDir(kind: string): string;
  /** 媒体缓存现状（文件数、占用、保留时长）。 */
  cacheStatus(): { files: number; bytes: number; keepHours: number; path: string };
  /** 立即清理（hours 省略用配置；all = 全清）。 */
  cleanupCache(opts: { hours?: number; all?: boolean }): {
    removed: number;
    freedBytes: number;
    kept: number;
    remainingBytes: number;
    hours: number;
    all: boolean;
  };
  /** 表情包页数据：本地数量/进度 + 已装包 + 收藏数。 */
  stickerStatus(limit: number): Promise<{
    local: {
      total: number;
      tagged: number;
      pending: number;
      byForm: { sticker: number; gif: number; photo: number };
      dir: string;
    };
    installed: Array<{ shortName: string; title: string; count: number }>;
    faved: number;
    localDir: string;
  }>;
  /** 本地表情标签：summary / save。 */
  stickerTags(action: string, payload?: unknown): {
    total: number;
    tagged: number;
    pending: number;
    byForm: { sticker: number; gif: number; photo: number };
    saved?: number;
  };
  /** 行为设置页：字段声明 + 当前值。 */
  behaviorFields(): { fields: SettingField[]; values: Record<string, unknown> };
  /** 保存行为设置（白名单字段，非法值抛错）。 */
  saveBehavior(patch: Record<string, unknown>): { message: string; values: Record<string, unknown> };
  /** 安装 / 卸载 Telegram 表情包。 */
  installStickerSet(shortName: string, install: boolean): Promise<string>;
  restart(): Promise<void>;
}

export const PANEL_IDS = ['login', 'chats', 'status', 'resources', 'stickers', 'behavior'] as const;

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

export function createPanel(panel: string, deps: PanelDeps) {
  if (!(PANEL_IDS as readonly string[]).includes(panel)) {
    throw new Error(`未知面板：${panel}`);
  }

  return {
    async invoke(method: string, args: unknown[] = []): Promise<unknown> {
      switch (method) {
        case 'status':
          return deps.status();

        case 'start_login': {
          const phone = asString(args[0]).trim();
          if (!phone) throw new Error('请填写手机号（带国家码，例如 +8613800138000）');
          return deps.startLogin(phone);
        }

        case 'submit_code': {
          const code = asString(args[0]).trim();
          if (!code) throw new Error('请填写验证码');
          return deps.submitCode(code);
        }

        case 'submit_password': {
          const password = asString(args[0]);
          if (!password) throw new Error('请填写两步验证密码');
          return deps.submitPassword(password);
        }

        case 'logout':
          return deps.logout();

        case 'set_credentials': {
          const apiId = asString(args[0]).trim();
          const apiHash = asString(args[1]).trim();
          if (!apiId || !apiHash) throw new Error('api_id 与 api_hash 必须成对填写');
          return { message: await deps.setCredentials(apiId, apiHash) };
        }

        case 'set_allowlist': {
          const users = asString(args[0]);
          const chats = asString(args[1]);
          return { message: deps.setAllowlist(users, chats) };
        }

        case 'list_dialogs': {
          const limit = Number(args[0]);
          const list = await deps.listDialogs(Number.isFinite(limit) && limit > 0 ? limit : 120);
          return { dialogs: list };
        }

        case 'toggle_allow': {
          const id = Number(args[0]);
          if (!Number.isFinite(id) || id === 0) throw new Error('会话 id 无效');
          const enabled = args[1] === true || args[1] === 'true' || args[1] === 1;
          const kind = asString(args[2]);
          return { message: deps.toggleAllow(id, enabled, kind), enabled };
        }

        case 'deps_status':
          return deps.depsStatus();

        case 'install_deps':
          return { started: deps.startDepsInstall() };

        case 'deps_progress':
          return deps.depsProgress();

        case 'history_defaults':
          return deps.historyDefaults();

        case 'read_messages': {
          const id = Number(args[0]);
          if (!Number.isFinite(id) || id === 0) throw new Error('会话 id 无效');
          const kind = asString(args[1]) || 'user';
          const limit = Number(args[2]);
          const safe = Math.max(10, Math.min(900, Number.isFinite(limit) && limit > 0 ? limit : 100));
          return { messages: await deps.readMessages(id, kind, safe), limit: safe };
        }

        case 'restart':
          await deps.restart();
          return { message: '正在重启 World…' };

        case 'resources_status':
          return { dirs: deps.resourceStatus() };

        case 'set_resources': {
          const raw = args[0];
          if (!raw || typeof raw !== 'object') throw new Error('缺少目录数据');
          const paths: Record<string, string> = {};
          for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            paths[key] = asString(value).trim();
          }
          return { message: deps.setResources(paths) };
        }

        case 'open_dir': {
          const kind = asString(args[0]).trim();
          if (!kind) throw new Error('缺少目录类型');
          return { message: deps.openDir(kind) };
        }

        case 'cache_status':
          return deps.cacheStatus();

        case 'cleanup_cache': {
          const raw = (args[0] ?? {}) as Record<string, unknown>;
          const hours = Number(raw.hours);
          return deps.cleanupCache({
            ...(Number.isFinite(hours) ? { hours } : {}),
            ...(raw.all === true ? { all: true } : {}),
          });
        }

        case 'sticker_status': {
          const limit = Number(args[0]);
          return deps.stickerStatus(Number.isFinite(limit) && limit > 0 ? Math.min(200, limit) : 60);
        }

        case 'behavior_fields':
          return deps.behaviorFields();

        case 'save_behavior': {
          const patch = (args[0] ?? {}) as Record<string, unknown>;
          if (!patch || typeof patch !== 'object') throw new Error('缺少设置数据');
          return deps.saveBehavior(patch);
        }

        case 'install_sticker_set': {
          const shortName = asString(args[0]).trim();
          if (!shortName) throw new Error('缺少表情包短名');
          return { message: await deps.installStickerSet(shortName, args[1] !== false) };
        }

        default:
          throw new Error(`未知方法：${method}`);
      }
    },
  };
}
