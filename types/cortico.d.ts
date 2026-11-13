/**
 * Cortico 框架契约快照（World API v6）。
 *
 * 为什么不是直接 import 框架源码：那会把整棵 Cortico 源码拉进本项目的
 * typecheck，而它有自己的一套 tsconfig 选项（allowImportingTsExtensions 等），
 * 两边冲突。扩展又必须独立于框架目录开发，所以这里按真实源码抄一份**只读契约**。
 *
 * 依据：Cortico-main/src/{world.ts, core/types.ts, core/config-schema.ts, core/language.ts}
 * 每一段都注明来源行号，升级 Cortico 时按行号复核即可。
 *
 * 运行时不需要这个文件——`cortico/*` 由框架的 module hook 解析（extensions/runtime.ts）。
 */

declare module 'cortico/core/language.ts' {
  /** 界面语言。真实定义在 core/language.ts，是一组字符串字面量联合。 */
  export type Language = 'zh' | 'en' | 'ja' | 'ko' | 'de' | 'fr' | 'it' | 'ru' | 'es-419' | 'pt-BR' | 'zh-Hant' | (string & {});
}

declare module 'cortico/core/config-schema.ts' {
  /** 来源：core/config-schema.ts:50 */
  export interface ConfigGroupSchema {
    type: 'object';
    title: string;
    description?: string;
    properties: Record<string, unknown>;
  }

  /** 来源：core/config-schema.ts:58 */
  export interface ConfigGroup {
    id: string;
    owner: 'core' | 'persona' | `world:${string}` | `provider:${string}`;
    schema: ConfigGroupSchema;
  }
}

declare module 'cortico/core/types.ts' {
  // ── 事件 ──────────────────────────────────────────────
  /** 来源：core/types.ts:16 */
  export type EventOrigin = 'external' | 'internal';
  /** 来源：core/types.ts:24 */
  export type EventTag = 'snapshot' | 'speak';

  /** 来源：core/types.ts:30 */
  export interface EventEnvelope {
    cursor: number;
    run?: string;
    type: string;
    ts: string;
    source: string;
    origin: EventOrigin;
    tags?: readonly EventTag[];
    contextDelivery?: 'deliver' | 'archive-only';
    text: string;
    senderKey?: string;
    meta?: Record<string, unknown>;
    blobs?: unknown[];
    ephemeral?: true;
  }

  /** 来源：core/types.ts:612 */
  export type TriggerMode = 'preempt' | 'interrupt' | 'flush' | 'debounce' | 'piggyback';

  /** 来源：core/types.ts:630 */
  export interface PushOptions {
    deliver?: boolean;
    trigger?: TriggerMode;
  }

  export type PushableEvent = Omit<
    EventEnvelope,
    'cursor' | 'origin' | 'contextDelivery' | 'blobs'
  > & { origin?: EventOrigin; blobs?: unknown[] };

  // ── 工具 ──────────────────────────────────────────────
  /** 来源：core/types.ts:185 */
  export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }

  /** 来源：core/types.ts:202 */
  export type ToolTag = 'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot';

  /** 来源：core/types.ts:256 */
  export interface ToolOutcome {
    text: string;
    blobs?: unknown[];
    failed?: true;
  }

  /** 来源：core/types.ts:229 */
  export interface ToolCallContext {
    role: string;
    log: Logger;
    queueExternalEvents?: (events: EventEnvelope[]) => void;
    callId?: string;
    round?: number;
    signal?: AbortSignal;
  }

  /** 来源：core/types.ts:264 */
  export interface ToolDef extends ToolSchema {
    tags: readonly ToolTag[];
    barrierAfter?: boolean;
    streamsOutput?: boolean;
    endsTurn?: boolean;
    interruptible?: boolean;
    handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolOutcome>;
  }

  /** 来源：core/types.ts:204 */
  export type DescribeText = string | { zh: string; en: string };

  /** 来源：core/types.ts:211 */
  export interface ToolDescribe extends ToolSchema {
    tags: readonly ToolTag[];
    summary?: DescribeText;
  }

  /** 来源：core/types.ts:218 */
  export interface EventDescribe {
    type: string;
    description: DescribeText;
    trigger?: TriggerMode;
    tags?: readonly EventTag[];
  }

  // ── 日志 ──────────────────────────────────────────────
  export interface Logger {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
    trace?(message: string, meta?: Record<string, unknown>): void;
    child(name: string): Logger;
  }

  // ── 宿主 ──────────────────────────────────────────────
  /** 来源：core/types.ts:687 */
  export interface WorldHost {
    pushEvent(e: PushableEvent, opts?: PushOptions): Promise<EventEnvelope>;
    pushDeferred(e: unknown, opts?: { trigger?: TriggerMode }): void;
    pushCandidate?(spec: unknown, opts?: { trigger?: TriggerMode }): Promise<readonly EventEnvelope[]>;
    store: unknown;
    drainPendingEvents(filter: (e: EventEnvelope) => boolean): Promise<EventEnvelope[]>;
    withdrawPending?(cursor: number): Promise<boolean>;
    promotePending?(cursor: number, trigger: 'flush' | 'preempt' | 'interrupt'): Promise<boolean>;
    modelFacts: { accepts(mime: string): boolean };
    blob(handle: string): { bytes: Uint8Array; mime: string } | null;
    reportUsage(usage: unknown, opts?: { model?: string; label?: string; charges?: unknown[] }): void;
    llmStalls?(withinMs: number): Promise<number>;
    cognition?: unknown;
    log: Logger;
  }

  // ── WebUI ─────────────────────────────────────────────
  /** 来源：core/types.ts:836 */
  export interface WorldLamp {
    label: string;
    state: 'online' | 'loading' | 'offline' | 'error';
    hint?: string;
  }

  /** 来源：core/types.ts:781 */
  export interface WorldPanelDecl {
    id: string;
    title: string;
    description?: string;
    getMethods?: readonly string[];
  }

  /** 来源：core/types.ts:1080 */
  export interface WorldStreamSocket {
    send(data: unknown): void;
    close?(): void;
  }

  /** 来源：core/types.ts:848 */
  export interface WorldWebUiDecl {
    label?: string;
    lamps?: WorldLamp[];
    badges?: Array<{ label: string; value: string | number; tone?: 'on' | 'off' | 'plain' }>;
    panels?: WorldPanelDecl[];
    invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;
    stream?(panel: string, socket: WorldStreamSocket): void;
    promptDocs?: unknown[];
    storage?: unknown[];
    links?: Array<{ label: string; href: string; inheritTheme?: boolean }>;
    config?: import('cortico/core/config-schema.ts').ConfigGroup[];
  }

  /** 来源：core/types.ts:752 */
  export interface StoragePart {
    key: string;
    label: string;
    kind: 'disk' | 'memory';
    location?: string;
    danger?: boolean;
    note?: string;
    order?: number;
    stat(): string;
    clear(): Promise<string> | string;
  }

  /** 来源：core/types.ts:911 */
  export interface World {
    id: string;
    envPromptVars(): Record<string, string> | null | Promise<Record<string, string> | null>;
    tools(): ToolDef[];
    webUi?(language?: import('cortico/core/language.ts').Language): WorldWebUiDecl;
    outputTap?(): unknown;
    start(host: WorldHost): Promise<void>;
    stop(): Promise<void>;
    onHandoffEnded?(): void;
    onTurnEnded?(): void;
    onEventsSettled?(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void;
    onRunPhase?(phase: unknown): void;
    shutdownVerification?(language: import('cortico/core/language.ts').Language): readonly unknown[];
  }
}

declare module 'cortico/world.ts' {
  import type { Language } from 'cortico/core/language.ts';
  import type {
    EventDescribe,
    ToolDescribe,
    ToolSpec,
  } from 'cortico/core/types.ts';
  import type { World } from 'cortico/core/types.ts';

  /** 来源：src/world.ts:24 */
  export type DeepPartial<T> = T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

  /** 来源：src/world.ts:20 */
  export interface WorldSection {
    enabled: boolean;
  }

  /** 来源：src/world.ts:31 */
  export interface WorldContext<S extends WorldSection = WorldSection> {
    readonly id: string;
    readonly cfg: S;
    readonly timezone: string;
    readonly botName: string;
    readonly botDir: string;
    readonly packageDir: string;
    readonly dataDir: string;
    readonly repoRoot: string;
    secret(name: string): string;
    storeSecret(name: string, value: string): void;
    persist(patch: DeepPartial<S>): void;
    restart(): Promise<void>;
  }

  /** 来源：src/world.ts:75 */
  export interface WorldDescribe {
    tools: readonly ToolDescribe[];
    events: readonly EventDescribe[];
  }

  /** 来源：src/world.ts:52 */
  export interface WorldDefinition<S extends WorldSection = WorldSection> {
    id: string;
    label: string;
    defaults(): S;
    preflight?(ctx: WorldContext<S>): void;
    configOptions?(kind: string, language: Language): Array<{ value: string; label: string }>;
    create(ctx: WorldContext<S>): World;
    describe?: WorldDescribe;
  }

  /** 来源：src/world.ts:84 */
  export function describeTools(
    decls: readonly ToolSpec[],
    summaries: Readonly<Record<string, import('cortico/core/types.ts').DescribeText>>,
  ): ToolDescribe[];
}

declare module 'cortico/web/shared/client-panel.ts' {
  /** 来源：src/web/shared/client-panel.ts:13 */
  export interface Disposable {
    dispose(): void;
  }
  /** 来源：src/web/shared/client-panel.ts:39（此处只列本扩展用到的成员） */
  export interface WebUiPanelContext {
    readonly pageId: string;
    readonly panelId: string;
    readonly language: string;
    readonly root: HTMLElement;
    readonly signal: AbortSignal;
    invoke<T = unknown>(method: string, args?: unknown[]): Promise<T>;
    invokeBinary(method: string, args?: unknown[]): Promise<Blob>;
    /** 来源：client-panel.ts:87 —— 轮询，unmount 自动停。 */
    interval(fn: () => void, ms: number): Disposable;
    /** 来源：client-panel.ts:90 */
    timeout(fn: () => void, ms: number): Disposable;
    /** 来源：client-panel.ts:75 —— 打开服务端主机的原生路径选择器。取消返回 null。 */
    pickPath(options: {
      kind: 'file' | 'directory';
      title?: string;
      currentPath?: string;
      recommendedDir?: string;
      extensions?: string[];
    }): Promise<string | null>;
  }

  /** 来源：src/web/shared/client-panel.ts:593 */
  export interface WebUiPanel {
    mount(ctx: WebUiPanelContext): void | Disposable | Promise<void | Disposable>;
  }

  /** 来源：src/web/shared/client-panel.ts:601 */
  export interface WebUiClientBundle {
    panels: Record<string, WebUiPanel>;
  }
}