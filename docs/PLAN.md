# Coopanion Telegram 个人账号 World — 实施方案（v0.2.0 重写）

> 状态：**待确认，未开始编码**。
> 检查对象：Coopanion 0.2.19 / Cortico World API v6（2026-11-10 实机）。
> 结论：契约足够，GramJS 可直接跑在 World 进程内，**不需要 Gateway、不需要改核心**。

---

## 0. 一句话结论

把这个扩展做成一个 `cortico.kind = "world"` 的独立 npm 包，id 沿用 `telegram`：

```
Telegram 云端
   ↕ MTProto（GramJS，进程内长连接）
World 实例（本扩展，跑在 Coopanion 主进程里）
   ↕ host.pushEvent / world.tools()
Coopanion Core：总线 → 主 session（曼城茶座人格/记忆/模型）→ 工具调用
```

**没有第二个进程，没有 Gateway，没有协议端，没有自己的 LLM。** 收发、媒体、贴纸全部走 MTProto；
回复通过 `speak` 标签的工具回到 World；人格/记忆/模型全部复用 Core。

**与 Telegram Desktop / 手机客户端同时在线**是硬要求，落地见 [§12](#12-与-telegram-desktop--手机客户端共存硬要求)：
独立 StringSession、绝不注销他人设备、三个账号级副作用（在线/已读/typing）默认全关。

---

## 1. Coopanion 接口分析（逐条对上你列的 9 项）

源码位置：`<Coopanion>/resources/app/build/cortico/src/`（打包态带完整 `.ts` 源码，可直接读）。

### 1.1 WorldDefinition 的真实接口

`src/world.ts:52`

```ts
interface WorldDefinition<S extends WorldSection = WorldSection> {
  id: string;
  label: string;
  defaults(): S;                                  // 每次返回新对象；enabled 默认 false
  preflight?(ctx: WorldContext<S>): void;         // 激活前检查，抛错=不能激活，信息原样给用户
  configOptions?(kind: string, language: Language): { value: string; label: string }[];
  create(ctx: WorldContext<S>): World;
  describe?: { tools: readonly ToolDescribe[]; events: readonly EventDescribe[] };
}
```

`WorldContext`（`src/world.ts:31`，`context()` 实现在 `:585`）：

| 成员 | 真实语义 | 对本扩展 |
|---|---|---|
| `cfg` | `worlds.telegram` 的**活引用**，读了立即生效；构造时快照的值要重启才更新 | 白名单/开关**热读**；api_id/session **冷读** |
| `dataDir` | `<部署>/data`（全区共享，**不是**每 World 一个） | 自建 `data/telegram/` |
| `botDir` | 部署根（`.../data/home/companion`） | `.env` 在这里 |
| `packageDir` | 代码包目录 | 模板/图标 |
| `secret(name)` | 读 `.env` / 进程环境 | `TG_API_ID` / `TG_API_HASH` |
| `storeSecret(name, value)` | 写 `.env`（权限收紧）+ 立即更新 `process.env`；**值不能含空白** | api_id/api_hash |
| `persist(patch)` | 深合并进 `worlds.telegram`（**数组整体替换**） | 白名单必须整表写回 |
| `restart()` | 按 `enabled` 重新激活实例（排队执行） | 改连接参数后重启 |

`World`（`src/core/types.ts:911`）：`id / envPromptVars() / tools() / webUi?(language) / outputTap?() / start(host) / stop() / onTurnEnded?() / onEventsSettled?() / onRunPhase?() / shutdownVerification?()`。

### 1.2 启动、停止、重载生命周期

`WorldAssembly`（`src/world.ts:206`）：

| 动作 | 实际发生什么 |
|---|---|
| 进程启动 | 对每个定义调 `create(ctx)` → 若 `worlds.<id>.enabled` 则进挂载表 |
| 激活 | `preflight(ctx)` → 工具名查重 → `enabled=true` 落盘 → `host.mount()` → `start(host)`；失败回滚 `enabled=false` 并重建实例 |
| 停用 | `unmount(id)` → `world.stop()` → `enabled=false` → **重建实例**（旧实例丢弃） |
| 重启 | `stop()` → 用**原对象**再 `start()`（配置改动靠这条生效） |
| 运行中失败 | 记 `failure`、卸载、`create()` 重建，不自动 `start()` |
| 工具重名 | `toolClash()`（`:524`）拒绝挂载：与保留名或已挂载 World 冲突都不行 |

对我们意味着：**`stop()` 必须彻底关掉 GramJS（disconnect + 清 handler + 清定时器）**，否则重载会留下第二条连接，
同一 session 双连接会被 Telegram 踢（`AUTH_KEY_DUPLICATED`）。

### 1.3 消息事件注册与投递

`WorldHost.pushEvent(e, opts)`（`src/core/types.ts:687`）：

```ts
pushEvent(e: {
  type: string; ts: string; source: string; text: string;
  senderKey?: string;            // 产生方定义的稳定过滤键
  meta?: Record<string, unknown>;// 不渲染进模型上下文，只给工具/面板用
  blobs?: BlobInput[];           // 附件：落库，模型能收就附带内容
  tags?: ('snapshot'|'speak')[];
  ephemeral?: true;
  origin?: 'external' | 'internal';
}, opts?: { deliver?: boolean; trigger?: TriggerMode })
```

`trigger`（`:612`）：

| 值 | 行为 | 本扩展用在哪 |
|---|---|---|
| `debounce` | 按 `quietGapMs / minBatchAgeMs / maxBatchAgeMs / maxBatchSize` 合批 | 关掉内部合并时的兜底 |
| `flush` | 立即投递整批积压 | **3 秒合并窗口到期后**用这个（延迟≈3s，不叠加核心的 2.5s） |
| `preempt` | 取消未产出的在途模型轮 | 不用 |
| `interrupt` | 停当前轮 | 不用 |
| `piggyback` | 只入队，随下一次唤醒 | 编辑/删除/反应/自己消息 |

合批默认值（`src/core/config.ts:116`）：`quietGapMs 2500 / minBatchAgeMs 0 / maxBatchAgeMs 15000 / maxBatchSize 100`。

事件正文由 World 自己排版（Core 不改写）。`senderKey` 用于按会话过滤 → 我们用 `chat:<chat_id>[:topic:<id>]`。

### 1.4 Agent 如何接收外部消息

`pushEvent(origin='external')` 落库 → 总线 → 主 session 的下一批投递。
`meta` 不进上下文，`text` 进上下文，`blobs` 按模型 MIME 能力附带。
**没有第二条「Agent 入口」**——World 只负责产生事件，怎么想是 Persona 的事。

### 1.5 Agent 回复如何回到 World

按 `ToolTag` 约定（`:202`）：`read / write / speak / act / flow / snapshot`。
`speak` = 对外发言；`act` = 改变外部状态但不发言。

回复路径（照 QQ World 已验证的「起草-确认门」）：

```
模型 → telegram_draft（tags:['speak'], barrierAfter:true）
     → 工具结果回执里列出「本轮期间新到的消息」
     → 模型再判断一次 → telegram_confirm(decision=send|cancel)
     → 真正调用 MTProto 发出，回执带 message_id
```

`barrierAfter` 让同一条 assistant 输出里排在它后面的工具调用被跳过（`:267`），
天然防「起草完顺手又发一条」。`onTurnEnded()` 里作废未确认草稿，防跨轮次误发。

**这是唯一能保证「不重复回复、不串线」的结构**：草稿保存的是发送目标快照，确认时不会重新取「最新会话」。

### 1.6 工具注册与调用

`World.tools(): ToolDef[]`，`ToolDef`（`:264`）：

```ts
{ name, description, parameters /*JSON Schema*/, tags: ToolTag[],
  barrierAfter?, streamsOutput?, endsTurn?, interruptible?,
  handler(args, ctx: ToolCallContext) => Promise<string | ToolOutcome> }
```

- 工具名在 bot 内唯一，挂载时查重（`:524`）。
- `ToolOutcome = { text, blobs?, failed?: true }`：**`blobs` 就是让模型「看见图」的通道**。
- `ctx.signal`（`:249`）：关机/换代时触发，**耗时工具必须在真正产生外部副作用前检查它**。
- `ctx.queueExternalEvents(events)`：工具执行期间取到的事件，接在本轮回执之后投递。
- `host.drainPendingEvents(filter)` + `ctx.queueExternalEvents` = QQ 的「起草时把新消息摆到眼前」。

`describe`（自描述）只给人和市场看，不进提示词；**实例 `tools()` 可以返回声明的子集**（官方允许，
但会记日志并在 World 页标注）。我们用它做「工具组开关」。

### 1.7 插件配置与持久化

- 配置段：`worlds.telegram`（`config.json`），默认值来自 `defaults()`；`persist()` 深合并，数组整体替换。
- 密钥：`storeSecret()` → `<部署>/.env`（`writeSecretFile`，权限收紧），值不能含空白。
- 面板配置表单：`webUi().config` 返回 `ConfigGroup[]`，字段名写全路径（`worlds.telegram.replyMode`），
  `x-hot: true` 表示热更新，否则提示重启。
- 运行数据：`<部署>/data/telegram/`（自建，受 `webUi().storage` 暴露，可一键清除）。

### 1.8 能否跑 GramJS 长连接

**能，且已有先例**：`cortico-world-qq` 在 World 里跑 `ws` 长连接 + 指数退避重连 + 串行消息链 +
定时器 + 磁盘 IO（`src/world.ts` 的 `driver` / `msgChain` / `setTimeout`）；`cortico-world-browser`
在 World 里跑 puppeteer。框架不限制网络与生命周期。

约束只有两条：
1. 依赖装在**包自己的** `node_modules`（`extensions/` 是 pnpm workspace 根，`link:` 包不代装依赖）。
2. `type: "module"` 必填；`cortico/*` 由 `extensions/runtime.ts` 的 module hook 映射到框架 `src/`。
   GramJS 是 CJS（`main: index.js`，`__esModule` + `Object.defineProperty(exports,"Api",…)`），
   Node ESM 的 cjs-module-lexer 认这种写法，`import { TelegramClient, Api } from 'telegram'` 可用；
   若实机探测失败，退到 `createRequire(import.meta.url)('telegram')`（一行兜底，已在计划内）。

### 1.9 扩展数据目录与依赖管理

| 项 | 实际位置 |
|---|---|
| 扩展包 | `<Coopanion>/data/extensions/node_modules/<包名>`（本项目是 `link:<你的扩展仓库路径>`） |
| 依赖安装 | 在**包目录**里 `npm install`（本项目已有独立 `node_modules`） |
| 包内运行数据 | `<Coopanion>/data/home/companion/data/telegram/` |
| 密钥 | `<Coopanion>/data/home/companion/.env` |
| 配置 | `<Coopanion>/data/home/companion/config.json` → `worlds.telegram` |
| 装载时机 | 进程启动时 import；**装卸/改代码都要重启进程**（ESM 缓存） |

现成接线（已存在，不需要动核心）：

```
extensions/package.json      "cortico-world-telegram": "link:<你的扩展仓库路径>"
extensions/world-owners.json "telegram": "cortico-world-telegram"
config.json                  worlds.telegram: { enabled: true, gatewayUrl: "ws://127.0.0.1:3010", … }
```

`gatewayUrl / requestTimeoutMs / reconnectBaseMs / reconnectMaxMs` 这 4 个旧字段本轮**废弃**，
新配置段由 `defaults()` 补齐；旧字段留在 `config.json` 里无害（深合并不会删键）。

### 1.10 从 QQ World 复用 / 不复用

| 复用 | 不复用 |
|---|---|
| 起草-确认门（单槽草稿 + 屏障 + 轮末作废） | OneBot v11 段结构、`message_id` 语义 |
| 白名单 + `enabled` 逐条热更新 + `announceWatchDiff` 播报 | 群号/QQ 号类型、`card`/`nickname` 逻辑 |
| 消息串行链 `msgChain`（严格按到达顺序落库） | 协议端重连/心跳/`fetch_ptt_text` |
| `knownMessages` 索引 + 「引用指向未记录消息时异步取原文」 | QQ 表情映射、JSON 卡片、合并转发展开 |
| 历史工具（`read`/`grep` 走 `host.store`） | 语音转写（协议端私有动作，TG 没有） |
| `webUi` 的 lamps / panels / storage / promptDocs 结构 | 视觉外包（TG 直接给模型 blobs） |
| `ENV_PROMPT.md` + `envPromptVars()` 三态（在线/断线沿用快照/未连接） | 图片 URL 猜测与下载重试 |

---

## 2. 整体架构

```
┌──────────────────────────── Coopanion 主进程 ────────────────────────────┐
│                                                                       │
│  Persona / 主 session（曼城茶座：人格 + 记忆 + 模型，原样复用）           │
│        ▲ 事件（external）              │ 工具调用（speak/read/act）      │
│        │                               ▼                              │
│  ┌──────────────── World: telegram ────────────────────────────────┐  │
│  │ inbound                    outbound                 domain      │  │
│  │  normalize → router →      draft/confirm            chats       │  │
│  │  dedupe → merge(3s) →      ratelimit → send         messages    │  │
│  │  pushEvent                 media/sticker            media       │  │
│  │        ▲                        ▲                   stickers    │  │
│  │        │                        │                   contacts    │  │
│  │  updates bridge            MTProto client（单例，串行化）          │  │
│  │        │                        │                              │  │
│  │  session-store（0600）    auth 状态机（手机/验证码/2FA/QR/导入）    │  │
│  └────────┼────────────────────────┼──────────────────────────────┘  │
│           │                        │                                 │
└───────────┼────────────────────────┼─────────────────────────────────┘
            ▼                        ▼
      Telegram DC（MTProto over TCP/TLS 或 WSS；可选 SOCKS5/MTProxy）
```

设计要点：

1. **单连接单例**：一个 `TelegramClient`，所有 RPC 走一个 `serial()` 队列；禁止并发建连（会 `AUTH_KEY_DUPLICATED`）。
2. **三层防串线**：`(chat_id, msg_id)` 复合键 → `meta.chat_id/topic_id` → 草稿快照目标。
3. **不伪造**：任何 RPC 失败都映射成明确错误码回执（`[send failed] FLOOD_WAIT 42s`），绝不返回假成功。
4. **能力按需**：`tools()` 按 `cfg.toolGroups` 裁剪；不支持的能力不出现在工具表里，`describe.json` 里标 `unsupported`。
5. **隐私**：session 只在 `data/telegram/session.txt`（0600），日志与面板一律掩码；`api_id/api_hash` 走 `.env`。

---

## 3. 功能模块划分

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `mtproto/` | 连接、重连、串行化、错误映射、限流、session 持久化、登录状态机、双开保护 | `client.ts` `auth.ts` `errors.ts` `ratelimit.ts` `session-store.ts` |
| `inbound/` | Update → 领域消息 → 授权 → 去重 → 合并 → 事件 | `normalize.ts` `router.ts` `dedupe.ts` `merge.ts` `events.ts` |
| `outbound/` | 草稿门、发送（文本/媒体/贴纸/回复/话题）、回执 | `draft.ts` `send.ts` |
| `domain/` | 会话、消息、媒体、贴纸、联系人、群组的 MTProto 封装 | `chats.ts` `messages.ts` `media.ts` `stickers.ts` `contacts.ts` |
| `tools/` | 工具声明表（分组/标签/schema）+ handler | `registry.ts` `read/*.ts` `write/*.ts` |
| `prompt/` | 环境提示词模板与中英文案 | `ENV_PROMPT.md` `strings.ts` |
| `webui/` | 登录面板、监听面板、事件面板；服务端 invoke 分发 | `server.ts` `client.ts` |

模块边界原则：`domain/` 不知道 Coopanion 存在（纯 MTProto，可单测）；`inbound|outbound` 只依赖 `domain`；
`tools/` 只做参数校验 + 调 `domain` + 排版回执；`world.ts` 只做接线与生命周期。

---

## 4. 文件结构设计

```
D:\Ai\cortico-world-telegram\
├─ package.json              name/type/cortico{kind:"world",api:6,icon,webUiClient,webUiStyle,describe}
├─ describe.json             自描述：全部工具 + 全部事件（含 unsupported 说明）
├─ README.md                 安装/登录/工具表/限制
├─ tsconfig.json
├─ scripts/build-webui.mjs   esbuild → dist/webui.js（已存在，沿用）
├─ types/cortico.d.ts        契约快照（按 v6 源码逐段复核）
├─ src/
│  ├─ index.ts               export { Telegram as default } from './definition.ts'
│  ├─ definition.ts          id:'telegram', defaults/preflight/create/describe
│  ├─ config.ts              TelegramConfigSection + DEFAULTS + SECRETS + configGroup(language)
│  ├─ world.ts               TelegramWorld implements World（start/stop/tools/webUi/envPromptVars/…）
│  ├─ mtproto/
│  │  ├─ client.ts           建连/重连/健康检查/串行 RPC/事件桥（唯一持有 TelegramClient）
│  │  ├─ auth.ts             登录状态机：phone→code→2FA / QR / import session / logout
│  │  ├─ session-store.ts    StringSession 读写（0600）、掩码、原子替换、损坏检测、state.json(lastSeenId)、instance.lock 双开保护
│  │  ├─ ratelimit.ts        令牌桶 + 每会话间隔 + FLOOD_WAIT 单次重试
│  │  └─ errors.ts           RPCError → { code, human, retryAfterSec }
│  ├─ inbound/
│  │  ├─ normalize.ts        Api.Message → InboundMessage（peer/thread/sender/media/entities）
│  │  ├─ router.ts           授权判定（allowUsers/allowChats/mentionOnly/ignoreBots/watchSelf）
│  │  ├─ dedupe.ts           (chat_id,msg_id) LRU（10 分钟 / 4096 条）
│  │  ├─ merge.ts            3 秒合并窗口（按 convKey，可关）
│  │  └─ events.ts           排版 + pushEvent（trigger 策略集中一处）
│  ├─ outbound/
│  │  ├─ draft.ts            单槽草稿（目标快照、轮末作废、drain 新消息）
│  │  └─ send.ts             文本/回复/话题/媒体/贴纸；回执格式统一
│  ├─ domain/
│  │  ├─ chats.ts            dialogs / getFullChat|Channel / topics / members / resolve
│  │  ├─ messages.ts         history / search / edit / delete / forward / react / read
│  │  ├─ media.ts            download / upload / info / 磁盘清理
│  │  ├─ stickers.ts         searchSets / getSet / fave / install / send / emojiKeywords
│  │  └─ contacts.ts         search / list / add / delete / fullUser
│  ├─ tools/
│  │  ├─ registry.ts         声明表（name/tags/group/parameters/description）
│  │  ├─ read.ts             只读工具 handler
│  │  └─ write.ts            写与发言工具 handler
│  ├─ prompt/
│  │  ├─ ENV_PROMPT.md       role=envPrompt 模板（变量 telegram.account / telegram.chats）
│  │  └─ strings.ts          面板与回执中文/英文
│  └─ webui/
│     ├─ server.ts           webUi().invoke 分发（login/watch/events 三个面板）
│     └─ client.ts           浏览器面板 bundle（dist/webui.js）
├─ dist/webui.js            构建产物（必须存在，否则页面报「缺少面板构建产物」）
└─ tests/
   ├─ unit/                 normalize/dedupe/merge/router/ratelimit/auth 状态机（全离线）
   ├─ contract.ts           definition 形状 + tools() + webUi() + envPromptVars() 快照
   └─ run.ts                入口（tsx）
```

---

## 5. 每个功能的真实实现方式（对照你给的功能清单）

标记：**✔ 支持** / **◐ 部分（有条件）** / **✘ 不支持（如实报错，不伪造）**

### 5.1 账号管理

| 功能 | 实现 | 状态 |
|---|---|---|
| 手机号登录 | `client.connect()` → `client.sendCode({apiId,apiHash}, phone)` 取 `phoneCodeHash` | ✔ |
| 验证码登录 | `Api.auth.SignIn({phoneNumber, phoneCodeHash, phoneCode})` | ✔ |
| 两步验证 | 捕获 `SESSION_PASSWORD_NEEDED` → `client.signInWithPassword({password})`（内部 GetPassword + SRP + CheckPassword） | ✔ |
| 二维码登录 | `client.signInUserWithQrCode` → `tg://login?token=` → 服务端出 PNG（`qrcode`）→ 面板轮询 | ✔（P2 加） |
| StringSession 持久化 | `(client.session as StringSession).save()` → `data/telegram/session.txt`，`chmod 0600`，原子写（tmp+rename） | ✔ |
| 自动恢复登录 | 启动读 session → `connect()` → `checkAuthorization()`；失败则面板回到登录态并说明原因 | ✔ |
| 断线重连 | `connectionRetries` + 30s 心跳（`Api.help.GetNearestDc` 轻量 RPC）+ 指数退避 1s→30s | ✔ |
| 退出登录 | `Api.auth.LogOut` → 删 session 文件 → 清 `worlds.telegram.sessionPresent` → 停连接 | ✔ |
| 账号状态查询 | 面板 + `telegram_account_status` 工具（`getMe` + 连接态 + 限流余量） | ✔ |
| 多账号 | 单账号（小号）。多账号需要多 World id，本轮不做 | ✘（明确告知） |

凭据存放：`api_id/api_hash` → `storeSecret('TG_API_ID'|'TG_API_HASH')` → `.env`；
session → `data/telegram/session.txt`（**不进 `.env`**，因为它是 400+ 字符单行凭据，且需要单独清除/轮换）。

### 5.2 消息功能

| 功能 | 实现 | 状态 |
|---|---|---|
| 接收私聊 | `NewMessage` handler；`peerId` 为 `PeerUser` | ✔ |
| 接收群组 | `PeerChat` / `PeerChannel`（`megagroup`） | ✔ |
| 读取历史 | `client.getMessages(entity,{limit,offsetId,offsetDate})`（= `messages.getHistory`） | ✔ |
| 发送文字 | `client.sendMessage(entity,{message,replyTo,parseMode,linkPreview,silent})` | ✔ |
| 回复指定消息 | `replyTo: message_id`（同会话校验；跨会话拒绝） | ✔ |
| 编辑消息 | `Api.messages.EditMessage` | ◐ 48h 内且自己发的 |
| 删除消息 | `Api.channels.DeleteMessages` / `Api.messages.DeleteMessages({revoke})` | ◐ 自己的可 revoke；他人的仅管理员 |
| 转发消息 | `Api.messages.ForwardMessages` | ◐ 频道禁止转发时失败（如实回执） |
| 消息搜索 | `Api.messages.Search({peer,q,filter,limit})`；跨会话 `Api.messages.SearchGlobal` | ✔ |
| 消息反应 | `Api.messages.SendReaction({peer,msgId,reaction:[ReactionEmoji]})` | ◐ 普通 emoji 免费；custom emoji 需 premium |
| 编辑/删除事件 | `UpdateEditMessage` / `UpdateDeleteMessages` → `piggyback` 事件 | ✔ |
| 已读回执 | `Api.messages.ReadHistory` | ✔ |

### 5.3 媒体与文件

| 功能 | 实现 | 状态 |
|---|---|---|
| 下载图片/视频/音频/文档 | `client.downloadMedia(msg,{outputFile})` → `data/telegram/media/<chat>/<msg>-<name>` | ✔ |
| 给模型「看」图 | 下载后回执 `ToolOutcome{text, blobs:[{bytes,mime,name}]}`（≤ 8MB 且模型 accepts(mime)） | ✔ |
| 发送本地文件 | `client.sendFile(entity,{file:path,caption,forceDocument})` | ✔ |
| 发送图片/视频 | 同上（按 MIME 自动 `InputMediaUploadedPhoto/Document`） | ✔ |
| 发送语音/音频 | `{voiceNote:true}`（ogg/opus）；音频走 document + `attributes:[DocumentAttributeAudio]` | ✔ |
| 获取媒体信息 | 解析 `msg.media`：`document.size/mimeType/attributes(duration,w,h)`、`photo.sizes` | ✔ |
| 超过 2GB | Telegram 上限 2GB（premium 4GB），超限直接报错 | ◐ |
| 转码/压缩 | 不做（无 ffmpeg 依赖），原样上传 | ✘ |

### 5.4 表情包与贴纸

| 功能 | 实现 | 状态 |
|---|---|---|
| 搜索贴纸 | `Api.messages.SearchStickerSets({q,hash:bigInt(0)})` | ✔ |
| 获取贴纸包 | `Api.messages.GetStickerSet({stickerset:InputStickerSetShortName,hash:0})` | ✔ |
| 收藏贴纸 | `Api.messages.FaveSticker({id:doc,unfave:false})` | ✔ |
| 发送贴纸 | `Api.messages.SendMedia` + `InputMediaDocument`（用 doc 的 `id/accessHash/fileReference`） | ✔ |
| 管理贴纸包 | `Api.messages.InstallStickerSet` / `UninstallStickerSet` | ◐ 归档包只读 |
| 表情相关信息 | `Api.messages.GetEmojiKeywords({langCode})` | ✔ |
| 自定义 emoji 发送 | 需要 premium + `InputMediaDocument` 的 `alt` 文档；非 premium 账号报错 | ◐ |
| 贴纸转图片 | 不转（webp/tgs 原样下载给模型可能不收）→ 明确标注 | ✘ |

### 5.5 联系人

| 功能 | 实现 | 状态 |
|---|---|---|
| 搜索用户 | `Api.contacts.Search({q,limit})` | ✔ |
| 获取联系人 | `Api.contacts.GetContacts({hash:bigInt(0)})` | ✔ |
| 添加联系人 | `Api.contacts.AddContact({id,firstName,lastName,phone})` | ✔ |
| 删除联系人 | `Api.contacts.DeleteContacts({id:[…]})` | ✔ |
| 查询用户资料 | `Api.users.GetFullUser({id})`（bio/commonChats/phone 仅联系人可见） | ◐ 陌生人不给手机号 |

### 5.6 群组与频道

| 功能 | 实现 | 状态 |
|---|---|---|
| 获取群组列表 | `client.getDialogs({limit})` 过滤 `isGroup` | ✔ |
| 获取群组信息 | `Api.messages.GetFullChat` / `Api.channels.GetFullChannel` | ✔ |
| 查看成员 | `client.getParticipants(entity,{limit,offset})` | ◐ 大群分页；需在群内；可能被 admin 限制 |
| 发送群消息 | `sendMessage(peer=channel)`，话题用 `topMsgId` | ✔ |
| 搜索频道 | `Api.contacts.Search` + `Api.messages.SearchGlobal` | ◐ 仅公开/已加入 |
| 获取频道信息 | `Api.channels.GetFullChannel` | ✔ |
| 读取频道消息 | `messages.getHistory(peer=channel)` | ◐ 需已加入；受限频道 `CHANNEL_PRIVATE` |
| Forum 话题 | `Api.channels.GetForumTopics`；发送 `replyTo: InputReplyToMessage({topMsgId})` | ✔ 非论坛群如实报「不是论坛群」 |

### 5.7 Agent 工具表（30 个，按组开关）

> 共 30 个工具，按组开关；`describe.json` 列全部，`tools()` 按 `toolGroups` 返回子集（契约允许，World 页会标注）。

| 组 | 工具 | tags | 说明 |
|---|---|---|---|
| conv（常开） | `telegram_draft` | speak | 起草一条回复（屏障） |
| | `telegram_confirm` | speak | 发送/作废草稿 |
| | `telegram_send_message` | speak | 发往指定会话（主动发起） |
| | `telegram_read_messages` | read | 读历史/某会话最近 N 条 |
| | `telegram_search_messages` | read | 关键词搜索（会话内/全局） |
| | `telegram_get_message` | read | 单条 + 媒体元数据 |
| | `telegram_list_chats` | read | 会话列表（最近 N 条摘要） |
| | `telegram_get_chat` | read | 会话详情（类型/成员数/话题） |
| | `telegram_account_status` | read | 账号/连接/登录态 |
| msg（常开） | `telegram_edit_message` | act | 编辑 |
| | `telegram_delete_messages` | act | 删除（revoke 可关） |
| | `telegram_forward_messages` | act | 转发 |
| | `telegram_react` | act | 加反应 |
| | `telegram_mark_read` | act | 标已读 |
| media | `telegram_download_media` | read | 下载 → 路径 + blobs |
| | `telegram_send_media` | speak | 本地文件/blob 句柄 → 会话 |
| | `telegram_media_info` | read | 媒体元数据（不下载） |
| sticker | `telegram_search_stickers` | read | 搜贴纸包 |
| | `telegram_get_sticker_set` | read | 包内贴纸清单 |
| | `telegram_send_sticker` | speak | 发贴纸 |
| | `telegram_fave_sticker` | act | 收藏 |
| | `telegram_install_sticker_set` | act | 安装/卸载 |
| contacts | `telegram_search_users` | read | 搜人 |
| | `telegram_get_user` | read | 资料 |
| | `telegram_list_contacts` | read | 联系人表 |
| | `telegram_add_contact` | act | 加联系人 |
| | `telegram_delete_contact` | act | 删联系人 |
| groups | `telegram_list_members` | read | 成员 |
| | `telegram_list_topics` | read | 话题列表 |
| | `telegram_resolve_chat` | read | @username/t.me 链接 → id |

> 默认 `toolGroups: ["conv","msg","media","sticker"]`；`contacts`/`groups` 默认也开（你要的能力），
> 但可一键关掉以省提示词 token。`describe.json` 列全部 30 个，`tools()` 返回子集——契约允许。

### 5.8 消息处理原则的落地

| 你的要求 | 实现 |
|---|---|
| 只响应指定用户 ID | `router.ts`：`allowUsers` 白名单（默认只有主号），其余**直接丢弃、不落库**（`archiveIgnored:false`） |
| 忽略陌生用户/未授权群 | 同上 + `allowChats[{id,enabled}]` 整表热更新 |
| 3 秒内合并 | `merge.ts`：按 `convKey` 缓冲，`mergeWindowMs=3000`（可 0 关）；到期 `pushEvent(trigger:'flush')` |
| 会话区分 | `senderKey = chat:<id>[:topic:<t>]`；`meta.chat_id/topic_id/chat_kind/chat_title` |
| 回复回到原会话 | 草稿保存 `{chatId, topicId, replyToMsgId}` 快照，确认时按快照发 |
| 防重复/串线 | ①`(chat_id,msg_id)` LRU 去重 ②单槽草稿 ③轮末作废 ④发送前 `ctx.signal` 检查 ⑤回执带 message_id |
| 过滤自己发的 | 三层判定：`message.out` → `sentIndex`（本插件发出的 id）→ `fromId==selfId`；默认 `watchSelf:"record"` 只归档不唤醒（详见 §12.1） |
| 自己发送的回录 | 发送成功后 `pushEvent(telegram.self, deliver:false)`，让「引用自己刚说的话」可用 |

---

## 6. 配置段设计（`worlds.telegram`）

```jsonc
{
  "enabled": true,
  "apiId": 0,                     // 冷：来自 .env TG_API_ID，面板只显示掩码
  "sessionPresent": false,        // 只读标志，面板据此显示「已登录/未登录」
  "watchPrivate": true,
  "watchGroup": true,
  "watchChannel": false,
  "watchSelf": "record",          // off | record(只归档不唤醒) | echo(当外部消息投递，慎用)
  "presence": "silent",           // silent(从不调 account.updateStatus) | onlineWhileRunning
  "autoMarkRead": false,          // 关=不动 Desktop 的未读红点
  "typingIndicator": false,       // 关=不在手机上显示「正在输入」
  "catchUp": true,                // 重连后按 lastSeenId 有界补齐
  "ignoreBots": true,
  "mentionOnlyInGroups": true,
  "allowUsers": [{ "id": 100000001, "enabled": true }],   // 主号
  "allowChats": [{ "id": -1001234567890, "enabled": true, "kind": "group" }],
  "mergeWindowMs": 3000,
  "mergeMaxAgeMs": 8000,          // 首条起最长等 8s（防连续消息饿死窗口）
  "mergeMaxItems": 10,            // 满 10 条立即 flush
  "replyMode": "direct",          // direct(默认，单调用) | review(draft→confirm 自查门)
  "guard": {                      // 高风险操作策略：auto | ask(需主号 !ok) | deny
    "sendOutsideAllowlist": "ask",
    "deleteRevoke": "ask",
    "forwardOutside": "ask",
    "contactWrite": "ask",
    "stickerSetWrite": "ask"
  },
  "mtLib": "teleproto",           // teleproto(默认) | telegram，由 docs/LIB-COMPAT.md 决定
  "toolGroups": ["conv", "msg", "media", "sticker", "contacts", "groups"],
  "maxMediaBytes": 8388608,       // 给模型看的 blobs 上限
  "mediaKeepHours": 72,
  "rateLimit": { "perChatMs": 1000, "globalPerMinute": 20 },
  "transport": { "useWSS": true, "proxy": "" },  // "" | socks5://… | mtproxy://…
  "timezone": ""                  // 空=跟随部署
}
```

`.env`：`TG_API_ID` / `TG_API_HASH`（`storeSecret` 写入，掩码显示）。

---

## 7. 开发阶段安排

| 阶段 | 内容 | 产出验收 | 预估 |
|---|---|---|---|
| **P0.0 库选型探针** | `scripts/probe.mts`：离线静态兼容 + 真账号六项功能探针；产出 `docs/LIB-COMPAT.md`，定 `MT_LIB` | 六项全 ✔ 的那个库定为默认依赖；业务代码零改动即可切换 | 0.5 天 |
| **P0 骨架 + 登录** | `port.ts` 适配层、definition/config/session-store/auth 状态机/登录面板/连接监督/更新桥/`history`/`sendText`/`getMe` + 3 个工具 | 见 §13.6 的 P0-1…P0-8，**真账号验收通过才算完成** | 1 天 |
| **P1 收发主链路** | normalize/router/dedupe/merge/events + `telegram_send_message` + env prompt + 事件面板 + 审批通道（`!ok`） | 主号发消息 → 3s 内到达 → 回复落回主号；无重复无串线 | 1.5 天 |
| **P2 历史与检索** | read/search/get/edit/delete/forward/react/mark_read + list_chats/get_chat | 五个读工具真实返回 MTProto 数据 | 1 天 |
| **P3 媒体** | download/send/media_info + blobs 接线 + 磁盘清理 + 上传进度 | 主号发图 → 模型看懂；工具发本地文件 → 主号收到 | 1 天 |
| **P4 贴纸** | search/get/fave/send/install + emoji keywords | 「搜个猫咪贴纸发给我」端到端 | 0.5 天 |
| **P5 联系人/群组** | contacts CRUD + user profile + members + topics + resolve | 群信息/成员/话题真实可读 | 1 天 |
| **P6 收紧** | 限流、错误映射全覆盖、参数校验、`describe.json`、README、E2E 验收表 | 全部验收项打勾 | 0.5 天 |

每阶段结束都跑一次 `tsc --noEmit` + 离线单测 + 真账号手测（P1 之后）。

---

## 8. 已知技术限制与风险

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | **GramJS（`telegram`）已归档**：2.26.22 是最后一版，官方指向 `teleproto`（同维护者的兼容分支，`Api`/`TelegramClient` 表面一致） | 长期无修 bug/无新 API（如新的 sticker 格式） | 按你的要求用 GramJS；把 `mtproto/client.ts` 做成唯一 import 点，换包只改 1 个文件。**要不要直接上 teleproto，等你定** |
| 2 | 自建 MTProto 客户端有账号风控风险（新号/异常 IP 可能被要求二次验证或限制私聊） | 小号可能被临时限制 | 用 my.telegram.org 自建 api_id；单实例；限流；deviceModel 用真实机型参数；被限制时如实报 `PEER_FLOOD` |
| 3 | 同一 session 双连接 → `AUTH_KEY_DUPLICATED`（Telegram 会踢旧连接） | 登录态抖动 | 单例 + `stop()` 彻底 disconnect + 重启前等旧连接关闭 |
| 4 | 网络：`149.154.x.443` 在部分线路不稳 | 收不到消息 | 默认 `useWSS:true`；支持 SOCKS5/MTProxy（`transport.proxy`） |
| 5 | 依赖体积：`telegram` + 15 个传递依赖（含 `websocket`/`buffer`/`socks`） | 包变大 | 只装运行时依赖；`skipLibCheck` |
| 6 | CJS/ESM 互操作 | `import { Api }` 可能失败 | 已确认 `index.js` 用 `__esModule` + `Object.defineProperty`（lexer 可识别）；兜底 `createRequire` |
| 7 | 消息 id 只在会话内唯一（不同会话可同号） | 错发/错引用 | 全部索引键 `(chat_id, msg_id)`；`meta` 必带 `chat_id` |
| 8 | `fileReference` 会过期（贴纸/媒体） | 发送旧引用失败 | 缓存只存 `id/accessHash`；发送前用 `messages.getMessages` 刷新 doc |
| 9 | `FLOOD_WAIT_X` / `PEER_FLOOD` | 发送失败 | 令牌桶 + 每会话 1s；`FLOOD_WAIT` 单次重试（按 retry_after），其余如实报错 |
| 10 | 群/频道量大 → 上下文爆炸 | token 成本 | 默认 `mentionOnlyInGroups:true`；白名单；3s 合并；`watchChannel:false` |
| 11 | 语音转写：MTProto 无公开转写接口 | 收到语音只能给文件 | 标 `unsupported`；只下载音频并告知模型「这是语音文件」 |
| 12 | 归档贴纸包只读、custom emoji 需 premium | 部分操作失败 | 回执写清原因，不假装成功 |
| 13 | session 文件 = 账号完全控制权 | 泄露即失号 | 0600 + 不进日志 + 面板掩码 + `storage` 可一键清除 + 不写入 `.env` |
| 14 | 改代码/装卸扩展必须重启进程（ESM 缓存） | 开发期反复重启 | 文档写明；面板提示「需要重启」 |
| 15 | `describe.json` 与 `tools()` 子集不一致 | World 页会标注 | 属允许行为，README 说明 |
| 16 | 账号的 Active Sessions 有上限（官方客户端满额时会自动挤掉最旧一条） | 极端情况下插件这条授权被挤掉 | 插件只占 **1 条**、设备名独立（`Coopanion Telegram World`）；被挤掉按 `SESSION_REVOKED` 停机提示重登（§12.3），**绝不** `resetAuthorizations` 去「抢位置」 |
| 17 | 你在 Desktop 手动终止插件会话 | 插件连不上，若死循环重试会刷 FLOOD | 检测 `AUTH_KEY_UNREGISTERED`/`SESSION_REVOKED` → 停重连 + error 灯 + 删死 session（§12.3） |
| 18 | 在线状态/已读/typing 都是**账号级**副作用 | 插件会让手机 24h 在线、消掉 Desktop 未读红点、显示「正在输入」 | 三个开关默认全关（`presence:"silent"`、`autoMarkRead:false`、`typingIndicator:false`，§12.2） |

---

## 9. 测试与验收标准

### 9.1 离线单测（无网络、无账号，`tests/unit`）

- `normalize`：私聊/群/频道/话题/媒体/回复/转发/服务消息 → `InboundMessage` 断言。
- `router`：白名单命中/未命中、`mentionOnly`、`ignoreBots`、`out` 自己消息、`watchSelf`。
- `dedupe`：同键二次到达只放行一次；LRU 淘汰；不同 chat 同 msg_id 不互相吞。
- `merge`：1s 内 3 条 → 一条事件（3 行）；4s 间隔 → 两条事件；`mergeWindowMs=0` → 逐条。
- `draft`：起草→新消息到达→确认仍发往原目标；`onTurnEnded` 作废；无草稿时 confirm 报错。
- `ratelimit`：每会话间隔、全局桶、`FLOOD_WAIT` 重试一次后放弃。
- `auth` 状态机：假 client 走 phone→code→2FA→authorized；错误码分支（PHONE_CODE_INVALID/EXPIRED/SESSION_PASSWORD_NEEDED）。
- `errors`：`FLOOD_WAIT_42 / PEER_FLOOD / CHANNEL_PRIVATE / MESSAGE_ID_INVALID` → 人类可读。
- `session-store`：写入权限、原子替换、损坏文件 → 视为未登录。

### 9.2 契约测试（`tests/contract.ts`）

- `default export` 形状：`id/label/defaults()/create()`；`id === 'telegram'`。
- `defaults()` 返回新对象、`enabled === false`、字段齐全。
- `preflight` 在缺 `TG_API_ID` 时抛错且信息可读。
- `create()` 后 `tools()` 名字唯一、`tags` 非空、`parameters.type === 'object'`；
  按 `toolGroups` 裁剪后仍在 `describe.tools` 里。
- `webUi('zh').panels[].id` 与 `dist/webui.js` 的 `panels` 键一一对应（缺一个就报「缺少面板构建产物」）。
- `envPromptVars()` 三态：未登录 → `null`/空；已登录 → 含账号行与最近会话；断线 → 沿用快照。

### 9.3 真账号 E2E（手动，一次性）

| # | 验收项 | 通过判据 |
|---|---|---|
| 1 | 登录 | 面板输入手机号 → 收到验证码 → 若开 2FA 输入密码 → 状态 `authorized`，显示自己 id/username |
| 2 | 自动恢复 | 杀进程重启 Coopanion，World 自动 `online`，无需再输验证码 |
| 3 | 主链路 | 主号发「在吗」→ ≤6s 内事件落库 → 小号回一条 → 主号收到，`message_id` 回执正确 |
| 4 | 合并 | 主号连发 3 条（间隔 1s）→ 只触发一次 Agent，正文含 3 行 |
| 5 | 串线 | 两个会话交替发消息 → 回复各自回到原会话，话题群回到原话题 |
| 6 | 自己消息 | 小号自己在手机上发一条 → 不触发 Agent（`watchSelf:false`） |
| 7 | 去重 | 断网 30s 再恢复 → 同一 `(chat,msg)` 不重复投递 |
| 8 | 媒体入 | 主号发图 → 工具可见 `log:` 句柄 / 模型能描述图内容 |
| 9 | 媒体出 | Agent 调 `telegram_send_media` 发本地文件 → 主号收到，大小/名称正确 |
| 10 | 贴纸 | 「搜猫咪贴纸发给我」→ 真实发出贴纸（主号可见） |
| 11 | 群/话题 | 群里 @小号 → `flush` 立即投递；话题群回复落在同一 topic |
| 12 | 编辑/反应 | `telegram_edit_message`/`telegram_react` 生效；对方的编辑事件以 `piggyback` 到达 |
| 13 | 失败诚实 | 对陌生人发消息 → 回执为 `[send failed] PEER_FLOOD…`，不出现假成功 |
| 14 | 登出 | 面板登出 → session 文件删除 → 工具报「未登录」 |
| 15 | 重载干净 | 停用再启用 World → 只有一条连接（不会 `AUTH_KEY_DUPLICATED`） |
| 16 | 三方共存 | Desktop + 手机 + 插件同时在线，三方收发互通；Desktop「设备」列表出现独立条目 `Coopanion Telegram World`，原有条目数不变 |
| 17 | 在线状态不被打扰 | 插件挂 30 分钟后，手机端在线状态仍随你实际使用变化（不变成 24h 在线/永久离线） |
| 18 | 已读不回退 | 插件收到消息后，Desktop 的未读红点仍存在（除非 Agent 显式 `telegram_mark_read`） |
| 19 | 重连隔离 | 拔网线 2 分钟再恢复：Desktop 不掉线、不弹验证、Active Sessions 无新增；插件自动恢复并补齐断线期间消息 |
| 20 | 会话被终止 | 在 Desktop 结束插件那条授权 → 插件 `error` 灯 +「会话已被其他设备终止，请重新登录」，**不**死循环重连、不重置其他设备 |

### 9.4 不上线即算失败的红线

- 任何工具 handler 返回硬编码成功字符串。
- `TODO` / 空实现 / 只声明不实现。
- 面板能点但后端没接线。
- 把 unsupported 包装成「已完成」。

---

## 10. 开工前需要你点头的 3 件事（已定 2026-11-10）

1. **MTProto 库** → 先跑双库探针（§13.1），六项全 ✔ 的定为 `MT_LIB`，**默认候选 `teleproto`**；业务代码只依赖 `port.ts`，换库零改动。
2. **落地位置** → 原地重写 `D:\Ai\cortico-world-telegram`（沿用 id `telegram` 与现有 `link:` 接线）；旧 gateway 版移到 `_legacy-gateway/`，不硬删。
3. **回复门** → 普通聊天默认 `direct`（单调用）；`review`（draft→confirm）作为可选自查门；**高风险操作走独立审批通道**（§13.5），不再把 `confirm` 说成「用户确认」。

---

## 11. 回滚方案

- 旧版代码：`D:\Ai\备份\cortico-world-telegram (2).zip`（14.5MB，2026-11-10 14:33）+ 原地 `_legacy-gateway/`。
- 配置：`config.json` 的 `worlds.telegram` 只增键不删键；回滚时把 `enabled` 置 false 即可停用，
  旧 `gatewayUrl` 字段仍在，旧版包放回即可恢复。
- 登录态：`data/telegram/session.txt` 删除 = 强制重新登录；不触碰其他 World 的数据目录。
- 本次交付只新增文档，**未修改任何代码、未删除任何文件**。

---

## 12. 与 Telegram Desktop / 手机客户端共存（硬要求）

MTProto 的授权模型：**一次登录 = 一条独立授权**（独立 DC + 独立 authKey + 独立 `perm_auth_key_id`），
在账号的 Active Sessions 列表里各占一行，互不覆写：

| 客户端 | 凭证放在哪 | 本插件是否接触 |
|---|---|---|
| Telegram Desktop | `%APPDATA%\Telegram Desktop\tdata`（加密本地存储） | **从不读、从不写、从不 import** |
| 手机客户端 | 手机本地 | 不接触 |
| 本插件 | `data/telegram/session.txt`（StringSession，只含本客户端 authKey/DC/端口，0600） | 只有它 |

所以「和 Desktop、手机同时在线」不是特例，是 MTProto 的**默认形态**——插件只是并列多一条授权。
（前提：用自己的 `api_id`/`api_hash`。若借用官方客户端的 api_id，设备列表里会显示成那个客户端，无法区分，且更易触发风控。）

### 12.1 五条要求的落地

| 你的要求 | 实现 | 验证 |
|---|---|---|
| 独立 StringSession，不占用/修改 Desktop Session | 新 authKey → `StringSession` → `session.txt` 0600；不 import tdata；只占 **1 个** Active Session 槽位 | Desktop「设备」出现独立条目 `Coopanion Telegram World`，原有条目数不变 |
| 不主动注销其他设备 | 代码里**没有** `auth.resetAuthorizations` / `account.resetAuthorization` / `account.deleteAccount`；登出只 `auth.logOut`（仅本条授权）+ 删本地 session | 单测：spy client 记录登录/重连/登出全流程的 invoke 类型，断言禁用方法**一次都没出现** |
| 正确接收其他客户端产生的更新 | updates 是**账号级**推送：Desktop/手机发的消息同样到本连接。`out:true` + `sentIndex` 判来源；断线期间 `catchUp()` 补齐 | 手机发一条 → 插件事件库有记录；Desktop 发一条 → 同上 |
| 区分自身消息、不自己触发自己 | 三层：`message.out` → `sentIndex`（本插件发出的 id）→ `fromId == selfId`。默认 `watchSelf:"record"` = 归档 `deliver:false`，**不唤醒** | 插件回复完不产生第二次 Agent 轮次；Desktop 自己发消息也不触发（除非显式 `echo`） |
| 重连不影响其他客户端 | 重连**复用同一 authKey**（不新建授权）；`instance.lock` 防双开；`presence:"silent"`；`autoMarkRead:false`；`typingIndicator:false` | 断网 2 分钟恢复：Desktop 不掉线、不弹验证、Active Sessions 无新增 |

`watchSelf` 三档：`off`（直接丢）/ `record`（默认，归档不唤醒，Bot 在历史里知道「这是你自己说的」）/ `echo`（当外部消息投递，**可能自己跟自己聊起来**，只给明确想要的人开）。

### 12.2 三个容易被忽略的「账号级」副作用（默认全关）

1. **在线状态**：`account.updateStatus(offline:false)` 会让账号 24 小时在线（手机半夜也显示在线）；
   `offline:true` 又会把你手机正在用的在线状态打掉。→ `presence:"silent"`，**一次都不调**。
2. **已读**：`messages.readHistory` 是账号级的，会把 Desktop 的未读红点一起消掉，对方还看到「已读」。→ 不自动已读，只有 Agent 显式调 `telegram_mark_read`。
3. **正在输入**：`messages.setTyping` 会让你的手机/Desktop 出现「对方正在输入」。→ 默认关闭。

### 12.3 会话被你在其他设备终止

你在 Desktop 的「设备」里结束 `Coopanion Telegram World` 后，本连接收到 `AUTH_KEY_UNREGISTERED` / `SESSION_REVOKED`。
处置（必须，禁止无限重试）：

1. 停重连，状态灯 `error`，面板显示「会话已被其他设备终止，请重新登录」；
2. 删除 `session.txt`（避免下次启动拿死 key 重试）；
3. **不触碰**其他设备的授权，不重置账号。

### 12.4 断线补课（catch-up）

GramJS 自己处理 pts 缺口，但长时间离线仍可能漏。重连后做一次**有界**补齐：
对白名单会话 `messages.getHistory(limit:50)`，只投递 `id > lastSeenId` 且 24h 内的消息；
`lastSeenId` 存 `data/telegram/state.json`（原子写）。补齐的事件带 `meta.catch_up=true`，Agent 能看出是补的。
上限：单次 ≤200 条 / ≤20 个会话，防重连风暴。

### 12.5 双开保护

同一份 session 被两个连接同时使用 → Telegram 判定 `AUTH_KEY_DUPLICATED` 并**作废该 key**（等于把你这条授权弄死）。
因此：`data/telegram/instance.lock`（pid + 启动时间），启动时若发现活跃锁 → 拒绝连接、error 灯提示「另一个 Coopanion 实例正在使用这条会话」。

---

## 13. P0 前修订（2026-11-10，六项）

> 你这六条都落在真问题上，尤其 13.4/13.5 是原方案的真实缺陷。以下为修订后的口径，**优先级高于前文冲突处**。

### 13.1 MTProto 库：适配层 + 双库探针，先评估后定依赖

**分层（业务代码不 import 具体库）**

| 层 | 文件 | 规则 |
|---|---|---|
| 端口 | `src/mtproto/port.ts` | 业务层唯一依赖。接口用**我们自己的领域类型**（`Msg` / `ChatInfo` / `SentRef` / `StickerSetInfo`…），**不出现任何 `Api.*`** |
| 选库 | `src/mtproto/lib.ts` | 全项目**唯一** `from 'teleproto' | 'telegram'` 的地方，按 `MT_LIB` 选择 |
| 实现 | `src/mtproto/impl/*.ts` | 用 lib 实现 port；`client.invoke(new Api.X())` **只允许**出现在这里 |
| 边界检查 | `tests/unit/import-boundary.test.ts` | 扫描 `src/`：`impl/` 与 `lib.ts` 之外出现 `from 'telegram'|'teleproto'` 即失败 |

**评估顺序（不通过就不换）**

1. **静态兼容（离线，`scripts/probe.mts`）**：ESM import、`TelegramClient` / `Api` / `sessions.StringSession` / `events.NewMessage`、client 原型上 15 个方法、32 个必需 TL 构造器、论坛话题（`channels.*` 或 `messages.*` 任一）、`InputReplyToMessage`/`InputMediaDocument`/`UpdateMessageID`。
   **已跑：两库均 11/11 通过**，差异只有论坛话题命名空间（见 `docs/LIB-COMPAT.md`）。
2. **真账号探针（需你的 api_id + 手机号）**：登录 → 2FA → `session.save()` → 重连 → `NewMessage` → `downloadMedia` → `contacts.getContacts` → `SearchStickerSets` + `GetStickerSet`。
3. 结果逐项写 `docs/LIB-COMPAT.md`，**六项全 ✔ 的那个定为 `MT_LIB`**，另一库退为探针依赖。

默认候选 `teleproto`（活跃）；任一项 ✘ → 回 `telegram`，业务代码零改动。

### 13.2 合并窗口与在途轮次：已提交事件不可变

三条硬规则：

1. 合并**只发生在 `pushEvent` 之前**（ingest 阶段），窗口键 = `convKey`。
2. 窗口关闭即冻结：`Object.freeze` 事件 payload（`text` / `meta` / `messages[]`）后再 push；此后新消息**只能**开新事件。
3. 模型处理期间到达的消息 = 新事件；Core 在本轮工具批次结束后投递（`flush` 语义），**不修改**当前轮输入。

防饥饿上限：`mergeMaxAgeMs: 8000`（首条起最长 8s）、`mergeMaxItems: 10`（满 10 条立即 flush）。

**验收（`tests/unit/merge.test.ts`）**：①窗口内 3 条 → 1 事件 3 行；②已 push 的事件对象 frozen，二次写入抛错；③连到 20 条 → 2 事件（10+10）；④模型在途时新消息 → 事件库 +1，旧事件字节不变。

### 13.3 断线恢复：两个层次，不许混称

| 通道 | 谁做 | 覆盖 | 能否称「完整恢复」 |
|---|---|---|---|
| `updates.getDifference` / `getState` | **库内部**（UpdateManager，基于本 session 的 `pts/qts/seq/date`） | 全量增量：新消息、编辑、删除、已读、反应、成员变更… | **是**（限该 session 的 update state） |
| 我们的 `catchUp()` | 本扩展 | **只有消息**（`messages.getHistory` 对比 `lastSeenId`） | **否**，仅「消息级补偿」 |

落地：
- **不自己调** `getDifference`（会与库的 UpdateLoop 抢 pts）；只读库暴露的同步状态；库未暴露时用 `Api.updates.GetState` **只读**取 `pts/date` 仅作展示，不做对齐。
- 面板分两行：`更新通道：已同步（pts=…，库报告）` / `消息补偿：补了 N 条（消息级，非完整恢复）`。
- 事件带 `meta.recovery="message-history"`、`meta.catch_up=true`；**禁止**在 UI/回执/日志出现「更新已恢复」措辞（`tests/unit/wording.test.ts` 扫字符串）。

### 13.4 自身消息识别：`updateMessageID` 预登记（探针已修正）

**探针实测（2026-11-10，见 `docs/LIB-COMPAT.md`）**：两个库的 `Api.Message` **都没有 `randomId` 字段**——
现代 layer 的 `message` 构造器已不含 `random_id`。原方案「用 `message.randomId` 认出自己的消息」**不成立**。
真正的关联通道是独立的 `updateMessageID#4e90bfd6 { id:int, random_id:long }`。

竞态：`messages.sendMessage` 的 `updateNewMessage` 可能**先于** RPC 返回到达，此时 `sentIndex` 还是空的 → 被误判成「Desktop 发的」。

三层修法：

1. **预登记（主）**：发送走**原始 invoke**（`Api.messages.SendMessage({ …, randomId })`，不用高层封装，因为它内部自己生成 random_id 我们拿不到）；
   `pendingSends.set(randomId, {chat, at})` 在 invoke **之前**完成；
   收到 `UpdateMessageID` → 把 `id` 写入 `sentIds`（本客户端所发）、清 pending；
   `UpdateNewMessage` 若先到，进 **2 秒隔离队列**等 `UpdateMessageID` 认领（不立即分类）。
   RPC 返回的 `UpdateShortSentMessage.id` 作为第二佐证。
2. **时间窗兜底**：2 秒内没等到 `UpdateMessageID` → `out && fromId===selfId && chat ∈ 近 60s 发送过的会话` 判为本客户端所发。
3. **去重兜底**：`(chat_id, msg_id)` LRU 保证两条路径都看见也只落一条。

`pendingSends` 带 120s TTL 清理，防泄漏。失败模式良性：即使第 2 层误判成「Desktop 发的」，`watchSelf:"record"` 也只归档一条 `deliver:false`，**不会**唤醒 Agent。

**验收（`tests/unit/own-message.test.ts`）**：三个时序各一条——①`UpdateMessageID` 先到；②`UpdateNewMessage` 先到、2s 内被认领；③两者都丢，仅靠时间窗。三种都断言：只落一条 `telegram.self`（`deliver:false`），不产生投递。

### 13.5 确认语义：draft-confirm 是自查，不是用户授权

**改口径**（文档/UI/日志统一）：`telegram_confirm` = **模型自查放行**，不代表用户同意。

**A. 普通聊天发送（低风险）**

- `direct`（**默认**）：`telegram_send_message` 单调用直接发；
- `review`：`telegram_draft → telegram_confirm` 两段，结构上保证「一轮一条、目标不漂移、可撤回」。

**B. 高风险操作（真正需要用户点头）—— `guard.ts` + `pendingApproval`**

| 动作 | 默认策略 |
|---|---|
| 文本回复白名单会话 | `auto` |
| 发往**非白名单**会话 | `ask` |
| `delete`（`revoke=true`） | `ask` |
| `forward`（转出白名单 / 批量） | `ask` |
| `add_contact` / `delete_contact` | `ask` |
| `install` / `uninstall_sticker_set` | `ask` |
| 其余读操作 | `auto` |

`ask` 执行流：

1. 工具**不执行**，立即返回 `[needs approval #A7F3] 即将删除 3 条消息…回复「!ok A7F3」批准 /「!no A7F3」取消`；
2. 扩展直接向**主号**发同一条确认消息（`messages.sendMessage`，不经 Agent）；
3. 主号回 `!ok A7F3` → `inbound/router` 识别为**控制指令**（不进 Agent、不唤醒、`deliver:false`）→ 执行并回执；
4. 5 分钟未回 → 作废，再调用时提示「已过期」。

这套是**真用户授权**，与 A 的自查门物理分开；`policy:"auto"` 时整套不启用。

### 13.6 P0 真实账号验收（先验收，再扩展）

| # | 项 | 判据 |
|---|---|---|
| P0-1 | 登录 | 面板手机号 → 验证码 → 2FA → `authorized`，显示 id/username |
| P0-2 | session 持久化 | `session.txt` 0600；重启进程自动恢复，不再输码 |
| P0-3 | 断线重连 | 断网 90s 恢复：自动连回、`pts` 前进、Desktop 不掉线不弹验证 |
| P0-4 | 多端共存 | Desktop + 手机 + 插件三方在线；Active Sessions 只多一个 `Coopanion Telegram World`；在线状态与已读不受影响 |
| P0-5 | 收 | 主号（或 Desktop）发一条 → 事件库有记录 → 去重后仅一条 |
| P0-6 | 发 | 工具发一条 → 主号收到；同 `random_id` 的回环不产生第二个事件 |
| P0-7 | 自身消息 | 插件自己发的只出现一次 `telegram.self`（`deliver:false`），不唤醒 Agent |
| P0-8 | 库选型 | `docs/LIB-COMPAT.md` 六项全 ✔ 的那个定为 `MT_LIB` |

**P0 范围（不多做）**：`port.ts` + 选库层 + 登录/登出 + session + 连接监督 + 更新桥 + `history` + `sendText` + `getMe` + 3 个工具（`telegram_account_status` / `telegram_send_message` / `telegram_read_messages`）+ 登录面板。
媒体/贴纸/联系人/群组的 port 接口先签名，实现体 `throw new UnsupportedError('P3')`，P3 之后逐个填。
