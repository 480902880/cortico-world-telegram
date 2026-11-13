# CHANGELOG

## 0.41.3 — 文档与一致性

- README 数字对齐实际：**47 个工具**（原 46）、**17 项行为设置**（原 16）、**7 个资源目录**（原 6）。
- 补上两个"声明了但模板没用"的变量：`{{telegram.account}}`、`{{telegram.contacts}}`（9 个变量全部生效）。
- `CHANGELOG` 补齐 0.27.0 之后的所有版本。

## 0.41.2 — 装卸贴纸包不再审批

- 删除配置项 `guard.stickerSetWrite` 与面板对应行；`telegram_install_sticker_set` 直接执行。
- 「敏感操作的确认」剩 4 项：删除消息 / 增删联系人 / 拉黑 / 白名单私聊发文件。

## 0.41.1 — 清掉假配置 + 面板减负

- **查出的假配置**：`guard.stickerSetWrite`（面板能配但代码没读，已接上后又按需求删除）、
  `approvalTtlMinutes`（写死 5 分钟，现跟随配置）、`ignoreBots` / `timezone`（无人读，删除）。
- 新增 `tests/unit/config-wired.test.ts`：`telegramDefaults()` 里每个叶子键都必须在源码里被引用。
- 面板灰字精简：白名单卡片去掉两段长解释；内置凭据提示压成一行。

## 0.41.0 — 删除双库开关

- GramJS（npm `telegram`）已归档并在 npm 标注 deprecated，官方指向 teleproto。
- 删除 `MT_LIB` 切换分支：`lib.ts` 只 import teleproto，错误提示改为"点一键安装依赖"。
- `docs/LIB-COMPAT.md` / `README` 同步。

## 0.40.0 — 可选审计日志（S-11）

- 新配置 `auditLog`（面板「隐私」页，默认关）：把工具调用写成 `data/telegram/audit.jsonl`。
- 只读工具跳过；写入前脱敏（api_hash、session 串、手机号）并截断 240 字；单文件超 5 MB 轮转一份。
- `withAudit()` 包在 `createTools()` 外层，47 个工具自动覆盖。

## 0.39.0 — 一条命令全检（P-02）

- `npm run verify` = typecheck → 全部单测 → describe → build:webui → 产物新鲜度校验。
- 新增 `npm run pack:check`（只校验不产包）、`.github/workflows/verify.yml`（Windows + Linux × Node 20）。

## 0.38.x — 安全文档（Q-03）

- 新增 `SECURITY.md`：登录态、监听边界、发送分级、审批语义、模型可见内容、本地数据一览、已知限制、加固建议。
- README 新增「安全默认值」表（12 项开箱行为）。
- `SECURITY.md` 随包发布（`files` 与打包清单都包含）。

## 0.37.x — 隐私开关落地 + 双开锁加固

- **假开关修复**：「在线状态」「自动标为已读」「发送正在输入」之前只存配置没人读。
  现在：`presence=onlineWhileRunning` 每 60 秒上报在线、退出时只离线本连接；`autoMarkRead` 真的标已读；
  `typingIndicator` 发文字前先上报 typing。
- **R-02**：`InstanceLock` 改为 `flag:'wx'` 原子创建 + 30 秒心跳 + 90 秒陈旧回收；释放只删自己的锁。
- 新增 `tests/unit/settings-wired.test.ts`：面板字段必须在代码里被引用（防假开关）。
- 内置 api_id 在面板上给出灰字提示（S-06）：公共凭据可能被限流，附 my.telegram.org 申请指引。

## 0.36.x — "让 bot 真正看见消息"

- **补上三类没订阅的事件**：编辑（`UpdateEditMessage`）、删除/撤回（`UpdateDeleteMessages`）、
  以及此前的反应（`UpdateMessageReactions`）——之前这些发生了 bot 完全不知道。
- 消息渲染补全：媒体带时长/大小/分辨率/贴纸表情/音频标题；投票·联系人·位置有可读文本；
  转发来源 `(转发自 X)`、`(已编辑)`、消息上已有的 `[反应 👍3]`。
- 引用消息带上被引用正文（`(回复 #327 「…」)`，120 字截断 + 缓存），不再是"只看到编号"。

## 0.35.x — 表情反应能唤醒模型

- 订阅 `UpdateMessageReactions` / `UpdateBotMessageReaction`，只对"自己发过的消息 + 白名单会话"生效。
- 新增 `src/mtproto/reactions.ts`（纯解析，20 项单测）。

## 0.34.0 — 依赖瘦身与自带 pnpm

- **一键安装依赖优先用 Coo 自带的 pnpm**（`ELECTRON_RUN_AS_NODE`），用户不必再自己装 Node；
  回退顺序：自带 pnpm → 系统 pnpm → 系统 npm → 明确提示。
- 删除已归档的 `telegram`(GramJS) 依赖；依赖自检只查真正在用的库。
- 安装带 `NODE_ENV=production`、`--no-audit --no-fund`。

## 0.33.x — 打包/权限/目录三道闸

- **P-01** 产物新鲜度校验：构建时写 `dist/webui.meta.json`（源码指纹），打包前比对，
  改了面板忘重建 → 直接中止打包（不再产出"看着正常其实是旧代码"的死包）。
- **S-09** Windows `icacls` 加固 `session.txt`：关继承，只留本人 / SYSTEM / Administrators（用 SID）。
- **S-07** 资源目录防手滑：拒绝盘符根、系统目录、用户主目录本身；文件过多只提醒不拦。

## 0.32.x — 群聊触发条件（S-04）

- 群里默认只在 **被 @ 或回复它** 时唤醒模型；其余消息照常入库但不叫模型（省 token）。
- 四种模式：`@ 或回复`（默认）/ `只认 @` / `只认白名单那个人` / `每条都理`。
- 触发记录自己发过的消息 id（每群最近 200 条），"刚发完就被回复"也认得出。

## 0.31.0 — 状态写盘攒批（R-01）

- `state.json` 从"每条消息同步重写"改为 **1 秒攒批 + 异步原子写**（实测 200 次写入 2417 ms → 1 次）。
- 游标自动裁剪：30 天无动静丢弃、上限 2000；`stop()` 时 `close()` 落盘，正常退出不丢。

## 0.30.x — 审批改成人话

- 不再要求 `!ok CODE`：主人回「可以 / 不行 / 随便你」都算数（词表覆盖常见近义说法）。
- **删掉系统模板通知**：审批消息由模型自己用话说，代码只负责记账与识别回复。
- 审批只认"私聊 + 审批人本人"；群里的"行"不算数。

## 0.29.x — 唱歌目录与"允许 ≠ 必须做"

- 新增第 7 个资源目录「唱歌目录」（`resources.song`），按目录归类：唱歌目录里的音频算 `song`。
- **唱歌不算外发文件**：翻唱/清唱/语音在任何会话都直接放行，不再走文件审批。
- 提示词新增「允许 ≠ 必须做」：配置只是不拦，做不做由 bot 按自己意愿判断。

## 0.28.x — 按会话类型分权

- 私聊真人：文字/表情/GIF/语音随便发；文件按配置（允许 / 先问我 / 不允许）。
- **群、频道、TG 机器人账号：一律不能发文件**，也不能做危险操作（删除、转发、拉黑、改联系人）。
- 白名单之外：不能主动发消息、不能转发过去（对应两项配置已删除）。
- 新增「允许 ≠ 必须做」，并把三档措辞从"直接执行"改为"允许（不询问）"。

## 0.27.5 — 致命错误分类（S-10）

- 分清四类：会话失效 / 账号封禁 → **立即停机**；双开 → 停机并提示；
  `PEER_FLOOD` → 暂停主动联系陌生人 24 小时（白名单不受影响）。
- 连接状态新增 `banned`；发送入口统一加 `assertCanReach()` 闸门。

## 0.27.0–0.27.4 — 主人身份与通知

- 口令归 Coo 自己判断，扩展不实现验证；`telegram_confirm_owner` 之类的"模型自报授权"方案已放弃。
- 保留 `telegram_notify_owner`（目标写死、每小时 10 条、同内容 10 分钟去重）；没配主人 ID 时降级为 `[skipped]`，不阻塞主流程。

## 0.26.3 — 安全热修（建议所有部署升级）

### 🔴 S-01 修复：`send_media` / `send_album` / 本地表情可外发任意本机文件

**问题**：`telegram_send_media`、`telegram_send_album` 接受任意绝对路径，也会把相对路径拼到
工作区、部署目录、数据目录下尝试，且**没有任何"必须在授权目录内"的校验**。
`session.txt`（等于账号完全控制权）与 `.env` 就在数据目录里；白名单会话里任何人发一条提示注入，
模型就可能把这些文件发到任意聊天。

**修复**：

1. 新增 `resolveForSend()`（`src/resources.ts`）：发送路径必须落在
   **资源目录 / 工作区 / 下载缓存**内，并且：
   - 文件名黑名单：`session.txt`、`state.json`、`instance.lock`、`resources.json`、`sticker-tags.json`、
     `.env*`、`id_rsa`、`.npmrc`、`.netrc` 等
   - 扩展名黑名单：`.pem` `.key` `.pfx` `.p12` `.kdbx` `.ppk` `.keystore`
   - 目录级封禁：`data/telegram/` 下除 `media/` 外一律禁止
   - 用 `realpathSync.native` 解析后比较，符号链接指到敏感文件同样被拒；Windows 下统一小写比较
2. `materializeSource`（`send_media` / `send_album` / blob 句柄）与本地表情发送全部走这套校验。
3. 错误信息不再回显"找过的路径"和任何绝对路径（工具结果会进模型上下文，可能被转述到聊天里）。

### ⚠️ 破坏性变更

**从任意路径直接发文件不再允许**（例如桌面上的图片）。把那个文件夹加进
「媒体目录」的某个槽位即可继续发送；主人身份判定完成后（0.27.0）会对主人放开。

### 升级后建议

- 如果曾把不可信的群或陌生人加入白名单，建议在 Telegram「设置 → 设备」里终止这条会话并重新登录。
- 升级前想先缓解：把所有群从白名单移除，只保留可信私聊。

---

## 0.26.2

- README 按实际能力重写（46 工具 / 6 面板 / 配置表 / 数据位置 / 三档限制）。
- 产品名统一为 **Coopanion**（设备名 `Coopanion Telegram World`）。

## 0.26.1

- 修正 `scripts/probe.mts` 里残留的旧产品名。

## 0.26.0

- 市场发布准备：`files` 白名单、`LICENSE`、`assets/screenshot-login.png`、
  `cortico.tags`、`scripts/pack.mjs`（打包产物自检）、`tests/market.ts`。
