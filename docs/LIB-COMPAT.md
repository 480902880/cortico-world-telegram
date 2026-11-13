# MTProto 库兼容性评估（P0.0）

- 探针：`scripts/probe.mts`（`npm run probe`，离线静态段）
- 环境：Windows / Node v23.11.1 / tsx 4.x / 项目 `D:\Ai\cortico-world-telegram`
- 实测时间：2026-11-10 19:06
- 被测：`teleproto@1.233.0`、`telegram@2.26.21`（npm 上是 2.26.22 发布的 GramJS，末版）

## 1. 静态兼容结果（11/11 全通过，两库相同）

| 检查 | teleproto | telegram |
|---|---|---|
| ESM `import`（CJS 包在 Node ESM 下可导入） | OK | OK |
| `TelegramClient` 命名导出 | OK | OK |
| `Api` 命名导出 | OK | OK |
| `sessions.StringSession` 可构造、可 `save()` | OK | OK |
| client 原型 15 个方法（connect/sendCode/signInWithPassword/sendMessage/sendFile/downloadMedia/getMessages/getDialogs/getParticipants/getMe/getEntity/invoke/addEventHandler/iterMessages/disconnect） | OK | OK |
| TL 构造器 32 个（auth/messages/channels/contacts/users/updates/upload/help） | OK | OK |
| 论坛话题方法（`channels.*` 或 `messages.*` 任一） | OK | OK |
| `InputReplyToMessage` / `InputMediaDocument` / `UpdateMessageID` | OK | OK |
| `events.NewMessage` | OK | OK |
| 自身消息关联通道 | OK（`UpdateMessageID`） | OK（`UpdateMessageID`） |
| 不联网构造 client | OK | OK |

## 2. 三个必须记住的差异

| # | 差异 | 影响 | 处置 |
|---|---|---|---|
| 1 | **论坛话题换了命名空间**：gramjs 用 `Api.channels.GetForumTopics / GetForumTopicsByID`；teleproto 已迁到 `Api.messages.GetForumTopics / GetForumTopicsByID` | 直接抄 gramjs 示例会在 teleproto 上报 “not a function” | 适配层 `impl/` 里做命名空间探测，业务层只调 `port.topics()` |
| 2 | **`message` 构造器已无 `random_id`**（两库一致，现代 layer 移除） | 原计划「用 `message.randomId` 认出自己发的消息」**不成立** | 改用 `updateMessageID{ id, random_id }` 关联（§13.4 已改） |
| 3 | 包体积/依赖：telegram 2.05MB / 226 files，依赖含 `websocket` `pako` `path-browserify`；teleproto 5.01MB / 433 files，依赖 `cifrante`(native crypto) `socks` `buffer` `big-integer` `node-localstorage` `mime`，启动日志 `crypto: native` | 安装体积、原生加密路径不同 | teleproto 走 Node 原生 crypto，CPU 开销更低；体积大 3MB 可接受 |

## 3. 结论

**只用 teleproto**，理由：

1. GramJS 已归档（npm 直接给 deprecated 警告，官方指向 teleproto），新特性（新 layer、新 sticker/forum 方法）只在 teleproto 里有；
2. 静态兼容性两库完全等价，teleproto 没有缺项；
3. 唯一差异（论坛话题命名空间）被适配层吸收，业务代码无感。

`telegram`（GramJS）**已不再安装**：`MT_LIB` 开关在 0.41.0 删除，`lib.ts` 只 import teleproto。
任一项探针对 teleproto 失败时不再有"切回另一库"这条退路——直接阻断发布。

## 4. 待办：真账号在线探针（P0 验收时跑）

需要 `TG_API_ID` / `TG_API_HASH`（my.telegram.org 自建应用）+ 手机号，六项：

| # | 项 | 判据 |
|---|---|---|
| O1 | 登录 + 2FA | `authorized`，`getMe()` 返回本账号 |
| O2 | StringSession | `session.save()` → 新 client 用该串 `connect()` 后 `checkAuthorization()===true` |
| O3 | 消息监听 | 另一设备发一条 → `NewMessage` 触发 |
| O4 | 文件下载 | `downloadMedia` 落地文件，字节数 > 0 |
| O5 | 联系人 | `contacts.getContacts` 返回列表（可为空） |
| O6 | 贴纸 | `SearchStickerSets('cat')` 有结果；`GetStickerSet` 返回 `documents` |

任一项对 teleproto 失败 → 阻断发布（不再有第二库可切）。
