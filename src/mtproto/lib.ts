/**
 * MTProto 库的唯一导入点 —— **懒加载**。
 *
 * 为什么必须懒加载：
 *   市场装上来的包默认没有 `node_modules`（依赖要用户点「一键安装依赖」才装）。
 *   如果在本模块顶层就 `import('teleproto')`，依赖缺失时整个扩展加载失败，
 *   连"去面板点安装依赖"这条路都断掉——用户只能看到一条 `Cannot find package` 报错。
 *
 * 所以：模块本身不碰依赖；真正用到时（`ensureLib()`）再加载，缺依赖就抛一句人话。
 *
 * 只支持 teleproto：GramJS（npm `telegram`）已被官方归档并在 npm 标了 deprecated。
 */

interface LibModule {
  TelegramClient: any;
  Api: any;
  sessions?: { StringSession?: any };
  utils?: any;
  version?: string;
}

const PACKAGE = 'teleproto';

/** 依赖缺失时给用户看的话（面板会原样显示）。 */
export const LIB_MISSING_HINT =
  `还没装依赖（找不到 npm 包 "${PACKAGE}"）。`
  + '去面板「登录」页点「一键安装依赖」，装完再重启这个 World 即可。';

let loaded: LibModule | null = null;
let eventsMod: Record<string, unknown> | null = null;
let loading: Promise<LibModule> | null = null;
let lastError: string | undefined;

/** 依赖是否已经可用（面板/状态用来决定显示"缺依赖"还是正常界面）。 */
export function libReady(): boolean {
  return loaded !== null;
}

/** 上一次加载失败的原因（没有失败则为 undefined）。 */
export function libLoadError(): string | undefined {
  return lastError;
}

/** 加载依赖（幂等，失败不缓存、下次还能重试）。 */
export async function ensureLib(): Promise<LibModule> {
  if (loaded) return loaded;
  if (loading) return loading;
  loading = (async () => {
    try {
      const mod = (await import(PACKAGE)) as LibModule;
      if (typeof mod.TelegramClient !== 'function' || !mod.Api) {
        throw new Error(`${PACKAGE} 的导出形状不符合预期（缺 TelegramClient 或 Api）`);
      }
      const events = (await import(`${PACKAGE}/events`)) as Record<string, unknown>;
      if (typeof (events.NewMessage ?? (events.default as any)?.NewMessage) !== 'function') {
        throw new Error(`${PACKAGE}/events 未导出 NewMessage`);
      }
      if (typeof (events.Raw ?? (events.default as any)?.Raw) !== 'function') {
        throw new Error(`${PACKAGE}/events 未导出 Raw`);
      }
      eventsMod = events;
      loaded = mod;
      lastError = undefined;
      return mod;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      throw new Error(LIB_MISSING_HINT);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function requireLib(): LibModule {
  if (!loaded) throw new Error(LIB_MISSING_HINT);
  return loaded;
}

/**
 * `Api` 用 Proxy 透传：业务代码里 `new Api.messages.SendMessage(...)` 照常写，
 * 真正取值时才检查依赖是否已加载。
 */
export const Api: any = new Proxy(
  {},
  {
    get(_target, prop) {
      return requireLib().Api[prop as string];
    },
  },
);

/** `utils`（getPeerId / getInputPeer 等）同理。 */
export const utilsApi: any = new Proxy(
  {},
  {
    get(_target, prop) {
      return requireLib().utils?.[prop as string];
    },
  },
);

/** `new TelegramClient(...)` 的门面：构造时才拿真正的类。 */
export class TelegramClient {
  constructor(...args: any[]) {
    const Ctor = requireLib().TelegramClient;
    return new Ctor(...args) as unknown as TelegramClient;
  }
}

/** `new StringSession(value)` 的门面。 */
export class StringSession {
  constructor(value?: string) {
    const Ctor = requireLib().sessions?.StringSession;
    if (typeof Ctor !== 'function') {
      throw new Error(`${PACKAGE} 未导出 sessions.StringSession，无法持久化登录态`);
    }
    return new Ctor(value) as unknown as StringSession;
  }
}

/** `new NewMessageEvent({})` 的门面。 */
export class NewMessageEvent {
  constructor(params: unknown) {
    const Ctor = (eventsMod?.NewMessage ?? (eventsMod?.default as any)?.NewMessage) as any;
    if (typeof Ctor !== 'function') throw new Error(`${PACKAGE}/events 未导出 NewMessage`);
    return new Ctor(params) as unknown as NewMessageEvent;
  }
}

/** `new RawEvent()` 的门面（无参形式，见 client.ts 里的说明）。 */
export class RawEvent {
  constructor(...args: any[]) {
    const Ctor = (eventsMod?.Raw ?? (eventsMod?.default as any)?.Raw) as any;
    if (typeof Ctor !== 'function') throw new Error(`${PACKAGE}/events 未导出 Raw`);
    return new Ctor(...args) as unknown as RawEvent;
  }
}

/** 库版本（未加载时为 'unknown'）。 */
export function libVersion(): string {
  return String(loaded?.version ?? 'unknown');
}

/** 论坛话题方法的命名空间：新 layer 在 messages.*，老 layer 在 channels.*。 */
export type ForumNamespace = 'messages' | 'channels' | null;

/** 取论坛话题的两个方法（列表 / 按 id）；不支持时返回 null。 */
export function forumTopics(): { get: any; getById: any } | null {
  if (!loaded) return null;
  const api = loaded.Api;
  const ns: ForumNamespace = typeof api.messages?.GetForumTopics === 'function'
    ? 'messages'
    : typeof api.channels?.GetForumTopics === 'function'
      ? 'channels'
      : null;
  if (!ns) return null;
  const bag = api[ns] as Record<string, any>;
  const get = bag.GetForumTopics;
  const getById = bag.GetForumTopicsByID;
  if (typeof get !== 'function' || typeof getById !== 'function') return null;
  return { get, getById };
}

/** 供面板/状态展示：当前库、版本、能力缺口。 */
export function libInfo(): { id: 'teleproto'; version: string; forum: ForumNamespace } {
  const api = loaded?.Api;
  const forum: ForumNamespace = api
    ? typeof api.messages?.GetForumTopics === 'function'
      ? 'messages'
      : typeof api.channels?.GetForumTopics === 'function'
        ? 'channels'
        : null
    : null;
  return { id: 'teleproto', version: libVersion(), forum };
}
