# cortico-world-telegram

Coopanion（Cortico）的 Telegram 个人账号扩展。用你自己的账号收发消息，和手机、电脑上的 Telegram 同时在线。
直连 MTProto，没有 Gateway，没有第二个进程，也不是 Bot API。

```
Telegram 云端
   ↕ MTProto（teleproto，进程内长连接）
本扩展（World API v6）——47 个工具 / 6 个面板 / 9 个模板变量
   ↕ pushEvent / tools()
Coopanion Core：人格 / 记忆 / 模型（原样复用，不改一行）
```

---

## 现在能做什么

一共 47 个工具，完整签名在 `describe.json` 里（也能用 `npm run describe` 重新生成）。

### 会话与人

| 工具 | 说明 |
|---|---|
| `telegram_list_chats` | 最近会话（名称 / @用户名 / id / 类型 / 未读） |
| `telegram_search_chats` | 按名字、@用户名、t.me 链接搜会话与联系人，返回候选 |
| `telegram_get_chat_info` | 会话资料：简介 / 成员数 / 是否论坛群 |
| `telegram_get_forum_topics` | 论坛话题列表（话题 id 就是发消息时的 `topic`） |
| `telegram_get_participants` | 群成员：分页 / 只看管理员 / 按名字搜 |
| `telegram_get_contacts` | 账号联系人 |
| `telegram_get_user_info` | 用户资料（含共同群数；受隐私限制的字段不出现） |
| `telegram_get_common_chats` | 和某人的共同群 |
| `telegram_add_contact` / `telegram_delete_contact` | 增删联系人（删除 ≠ 拉黑） |
| `telegram_block_user` / `telegram_unblock_user` / `telegram_get_blocked` | 拉黑 / 解除 / 名单 |
| `telegram_mute_chat` | 静音会话（0=取消、-1=永久、N=分钟） |
| `telegram_status` | 账号、连接状态、白名单规模 |

### 消息

| 工具 | 说明 |
|---|---|
| `telegram_send_message` | 发文字，可引用、可发到话题 |
| `telegram_read_messages` | 读最近消息，可按话题 |
| `telegram_search_messages` | 会话内按关键词搜 |
| `telegram_get_message` | 按 id 取单条 |
| `telegram_edit_message` / `telegram_delete_message` | 编辑 / 删除 |
| `telegram_forward_messages` | 转发（转出白名单受 `guard.forwardOutside` 约束） |
| `telegram_send_reaction` / `telegram_get_reactions` | 加反应 / 查谁加了什么 |
| `telegram_mark_read` | 标记已读（账号级，会消掉手机/电脑版红点） |

### 媒体

| 工具 | 说明 |
|---|---|
| `telegram_download_media` | 下载图片 / 视频 / 语音 / 文件；图片附给模型 |
| `telegram_send_media` | 发本地文件；`as_voice` 用 ffmpeg 转语音条（ogg/opus） |
| `telegram_send_album` | 2–10 张图一次发（相册） |
| `telegram_find_local_media` | 在配置的资源目录里找最近生成的文件 |
| `telegram_register_local_media` | 登记别的 World 产出（必须落在授权目录内） |
| `telegram_cleanup_media` | 清下载缓存（按小时 / 全清） |

### 表情包与 GIF

| 工具 | 说明 |
|---|---|
| `telegram_search_stickers` / `telegram_get_sticker_set` | 搜包（文字或单个 emoji）/ 看包内清单 |
| `telegram_send_sticker` | 发表情：来自 Telegram 包（序号或 emoji）**或**本地文件 |
| `telegram_list_stickers` | 列出两个来源：本地目录 / 已装包 |
| `telegram_tag_local_stickers` | 给本地表情打语义标签（看图 → 写关键词和适用场景） |
| `telegram_install_sticker_set` / `telegram_get_installed_stickers` | 装卸包 / 已装列表 |
| `telegram_fave_sticker` / `telegram_get_favorite_stickers` | 收藏 / 收藏列表 |
| `telegram_search_gifs` / `telegram_send_gif` | 走 @gif 内联机器人，**中文能搜** |

### 日常整理

`telegram_pin_message`（置顶，私聊对双方可见）· `telegram_archive_chat`（归档）·
`telegram_save_message`（转存 Saved Messages）· `telegram_get_folders`（聊天文件夹列表）

### 自动做的事（不需要工具）

- **收到图片自动附给模型看**；视频 / 文件附**缩略图**（不下载整段）
- **消息合并窗口**：同一会话连发时按下表合并成一条事件
- **发送限流**：每会话 1 秒 / 全局 20 条每分钟
- **FloodWait**：≤60 秒等一次重试，>60 秒如实报错
- **断线补课**：重连后按 `lastSeenId` 补 24 小时内、≤200 条；运行中每 10 分钟兜底
- **媒体缓存清理**：超过保留时长的下载文件自动删

做不成的事会直接报错，不会假装成功：工具返回 `[failed] …`，端口层抛 `UnsupportedError`。

---

## 安装

### 市场安装（推荐）

从扩展市场装好后，打开 **Telegram → 登录**：顶部「依赖自检」会告诉你就绪或给一个
**「一键安装依赖」** 按钮（跑 `npm install` + `npm run build:webui`，日志就在卡片里滚）。
装完刷新页面即可登录。

### 手动安装（源码）

把目录放到 `<Coopanion>/data/extensions/node_modules/cortico-world-telegram`，
或在 `<Coopanion>/data/extensions/package.json` 里写 `"cortico-world-telegram": "link:<你的路径>"`。

```bash
npm install
npm run build:webui   # 生成 dist/webui.js（缺它面板打不开）
npm run describe      # 生成 describe.json
```

改完代码必须**重启 Coopanion 进程**（ESM 缓存，不支持热换）。

---

## 登录

1. 打开 Coopanion → **Telegram → 登录**
2. 填手机号（带国家码，如 `+8613800138000`）→ 发送验证码
3. 填 Telegram 收到的验证码；开了两步验证再填密码
4. 状态灯转绿即成功，`session.txt` 落盘（0600），下次启动自动恢复
5. 切到 **会话** 页签点「监听」把会话加进白名单 —— **不加就永远不会唤醒它**

### api_id / api_hash

三者按优先级取**一组**（必须成对）：面板填的 → 部署 `.env` 的 `TG_API_ID`/`TG_API_HASH` → **内置默认**。

内置默认是 Telegram Desktop 的公开凭据，**无需注册即可登录**，代价是：设备列表里这条显示成
"Telegram Desktop"，且可能被 `API_ID_PUBLISHED_FLOOD` 限流。稳妥做法是去
[my.telegram.org](https://my.telegram.org) 建自己的应用，面板里换上、重启 World。

设备名固定为 `Coopanion Telegram World`，与 api_id 无关。

---

## 与手机版 / 电脑版共存

- **独立授权**：每次登录 = 一条独立 authKey，只占 1 个设备槽位；从不读写 `tdata`
- **不注销别人**：代码里没有 `auth.resetAuthorizations` / `account.resetAuthorization`（单测断言过）
- **不打扰状态**：`presence=silent`（不调 `account.updateStatus`）、不自动已读、不发 typing
  —— 这三样在 Telegram 都是账号级的
- **双开保护**：`instance.lock`，同时跑两个 Coopanion 会被拒绝（否则 Telegram 作废 key）

---

## 面板（6 个）

| 页签 | 干什么 |
|---|---|
| **登录** | 依赖自检 / 一键装依赖、手机号登录、凭据（api_id/hash）、登出、重启 |
| **会话** | 会话列表 + 白名单开关；**双击任一会话看最近历史**（默认 100 条，可调 10–900） |
| **媒体目录** | 7 个资源目录（语音/唱歌/图片/视频/文件/表情包/下载）+ 下载缓存占用与清理 |
| **表情包** | 本地表情数量与打标签进度、已装包、装/卸 |
| **行为** | 17 项开关：监听范围、媒体、隐私、合并窗口、4 个敏感操作的确认策略 |
| **状态** | 连接 / 登录 / 库版本 / 会话文件 / 监听数 / 待确认操作 |

另有 **配置**（热改 5 项）、**Telegram 环境提示词**、**数据清理** 三个框架页。

---

## 配置

### 配置页（改完立刻生效）

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.telegram.watchPrivate` | `true` | 监听私聊 |
| `worlds.telegram.watchGroup` | `true` | 监听群组（仍需加白名单） |
| `worlds.telegram.watchChannel` | `false` | 监听频道（默认关，避免刷屏） |
| `worlds.telegram.mergeWindowMs` | `3000` | 消息合并窗口 ms；0 = 逐条投递 |
| `worlds.telegram.mediaKeepHours` | `72` | 媒体缓存保留小时；0 = 不自动清理 |

### 行为页（17 项，保存即生效）

- **监听范围**：你在手机版/电脑版上发的消息（忽略 / 只记录 / 照常处理）、断线补课
- **媒体**：图片自动附给模型、视频/文件缩略图、附件体积上限（**MB**）
- **隐私**：在线状态（保持沉默 / 显示在线）、自动标已读、发送「正在输入」
- **合并窗口**、**会话页默认历史条数**
- **4 个确认策略**：删除消息、增删联系人、拉黑、白名单私聊发文件
  —— 每个可选 `直接执行` / `先问我`（Telegram 回 `!ok`）/ `不许做`

其余键（`rateLimit`、`maxMediaBytes`、`ffmpegPath`、`resources`、`guard.*`）见 `src/config.ts` 的默认值。

---

## 数据位置

```
<Coopanion>/data/home/companion/data/telegram/
├─ session.txt        StringSession（0600，等于账号控制权，别外传）
├─ state.json         每个会话的 lastSeenId
├─ instance.lock      双开保护
├─ resources.json     本地资源登记索引
├─ sticker-tags.json  本地表情的语义标签
└─ media/             下载与转码产物（按保留时长自动清理）
```

`.env` 里只放 `TG_API_ID` / `TG_API_HASH`；session 不进 `.env`。

---

## 安全默认值

完整说明见 [SECURITY.md](SECURITY.md)，这里只列"开箱即是什么"：

| 项 | 默认 | 意思 |
|---|---|---|
| 监听范围 | **空** | 谁都不听，直到你把会话加进白名单 |
| 群里什么时候理人 | **@ 或回复** | 其他消息只入库，不唤醒模型（省 token） |
| 在线状态 | **保持沉默** | 从不调 `account.updateStatus`，不影响你手机/桌面 |
| 自动标为已读 | **关** | 不会消掉你别的设备上的未读红点 |
| 白名单私聊发文件 | **允许** | 群 / 频道 / TG 机器人账号仍然一律不能发文件 |
| 发到白名单以外 | **不允许** | 名单外的人收不到、也不发过去 |
| 发送路径 | **白名单目录** | 只能发资源目录/工作区/媒体缓存；私钥与 `session.txt` 这类文件永远发不出去 |
| 资源目录 | **拒绝宽目录** | 盘符根、系统目录、用户主目录本身都存不进去 |
| `session.txt` | **0600 + Windows ACL** | Windows 上额外用 `icacls` 关掉权限继承 |
| 双开 | **原子的锁** | 同一份 session 被两处用会让 Telegram 作废授权，所以启动就拦 |
| 致命错误 | **立即停机** | 会话失效 / 账号被封 / 双开 → 不重连，等你自己处理 |
| `PEER_FLOOD` | **24 小时只放行白名单** | 被判骚扰后不再碰陌生人 |

---

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=480902880/cortico-world-telegram&type=Date)](https://star-history.com/#480902880/cortico-world-telegram&Date)
