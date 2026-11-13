# 状态与剩余（2026-11-12 · v0.26.2）

口径：**已实现（离线测过）** / **已实现 + 真机验证** / **未开始**

规模：**46 工具 · 6 面板 · 9 模板变量 · 24 组单测 + 契约 + 市场自检**

---

## 1. 已完成（全部离线通过）

**会话与人**：list_chats · search_chats（@用户名/t.me/名字/重名候选）· get_chat_info ·
get_forum_topics · get_participants（分页/管理员/按名搜）· get_contacts · get_user_info（含共同群）·
get_common_chats · add_contact · delete_contact · block_user · unblock_user · get_blocked · mute_chat · status

**消息**：send_message（引用/话题）· read_messages（可按话题）· search_messages · get_message ·
edit_message · delete_message · forward_messages · send_reaction · get_reactions · mark_read

**媒体**：download_media · send_media（语音条自动转 ogg）· send_album（2–10 张）·
find_local_media · register_local_media · cleanup_media

**表情包 / GIF**：search_stickers · get_sticker_set · send_sticker（Telegram 包 / 本地文件两种来源）·
list_stickers · tag_local_stickers（语义标签）· install_sticker_set · get_installed_stickers ·
fave_sticker · get_favorite_stickers · search_gifs · send_gif（@gif，中文可搜）

**日常**：pin_message · archive_chat · save_message（进 Saved Messages）· get_folders

**自动化**：收到图片自动附给模型 · 视频/文件缩略图 · 消息合并窗口（3s 窗口 / 8s 上限 / 10 条上限）·
发送限流（1s/会话、20/分钟）· FloodWait 分级重试 · 断线补课（启动+重连+每 10 分钟）· 媒体缓存定时清理

**界面**：登录（含依赖自检与一键安装）· 会话（双击看最近 100 条，可调 10–900）· 媒体目录（含缓存卡片）·
表情包（数量 + 标签进度 + 装卸）· 行为（16 项）· 状态

---

## 2. 未在真机验证（代码完成，缺实测）

| # | 项 | 风险 |
|---|---|---|
| V1 | 群成员 / 论坛话题 / 发到话题 | 需群权限，可能被 Telegram 限制 |
| V2 | 编辑 / 删除 / 转发 / 反应 / 标记已读 | 权限或账号类型可能导致失败 |
| V3 | 本地表情发送（png/webp/tgs/webm→表情、gif→动图、jpg→图片） | **最可能被 Telegram 挑格式** |
| V4 | 置顶 / 归档 / 静音 / 拉黑 | 账号级副作用，语法对但未跑 |
| V5 | GIF 搜索（@gif 内联机器人） | 依赖内联机器人可用性 |
| V6 | 联系人 / 用户资料 / 共同群 | 隐私限制下可能空结果 |
| V7 | 合并窗口 / 限流 / 补课 | 需要真实连发、真实限流、真实断网 |

**已真机验证**：登录、session 恢复、文字收发、面板基本流程。

---

## 3. 未开始

| # | 项 | 说明 |
|---|---|---|
| N1 | 投票（建/读/参与） | 冷门 |
| N2 | 位置与联系人名片 | 冷门 |
| N3 | 聊天文件夹**管理** | 只读列表已有 |
| N4 | 图片压缩 / 尺寸检查 | 发大图前可加 |
| N5 | 语音转写（ASR） | **不做进本扩展**，后续单独写转写插件接入 |
| N6 | 草稿门（`replyMode: review`） | 配置项在，逻辑未实现；选它等同直发 |
| N7 | 24h+ 长跑压测 | 观察重连 / 重复事件 / 内存 |
| N8 | 管理员删他人消息的权限路径 | 现在靠 Telegram 报错 |
| N9 | 市场正式上架 | tags / 作者 / 截图已填，待最终版 |

---

## 4. 建议顺序

1. **V1–V7 真机过一遍**（功能已全，卡在没实测；这比加新功能重要）
2. N7 长跑观察（挂一晚上看日志有没有重复事件 / 内存涨）
3. N1–N4 按需补
4. N5 ASR 单独插件
