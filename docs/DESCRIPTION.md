# 扩展描述（三语）

> 用于市场详情页、npm 页面、README 开头。三个语言版本内容等价，可按平台截取。

---

## 中文

### 一行版（市场简介 / 列表）

在 Coopanion 里用你**真实的 Telegram 个人账号**收发消息、媒体与表情——白名单说了算，默认保持安静，和桌面版、手机同时在线。

### 段落版（详情页 / README）

这不是一个机器人。它用你自己的 Telegram 账号（MTProto 直连，不是 Bot API），所以对面看到的是你本人，聊天记录也在你账号里。接上 Coopanion 之后，模型可以帮你读消息、回消息、发文件、发表情、找群找话题，但它只听你允许的会话，默认不显示在线、不点已读、不主动打扰任何人。

### 能力

- **会话**：好友/群/频道/论坛话题、成员、共同群、通讯录
- **消息**：发送、回复引用、编辑、删除、转发、表情反应、标记已读、搜索
- **媒体**：图片/视频/文件/相册；语音条自动转码；下载与缓存清理
- **表情与 GIF**：Telegram 贴纸包、本地表情目录（webp/tgs/webm/gif/jpg 自动识别形态）、中文搜 GIF
- **唱歌**：单独的「唱歌目录」，RVC 等翻唱产物直接发，不走文件审批
- **47 个工具 / 6 个面板 / 9 个模板变量**

### 安全默认值

- 监听白名单：名单外的人**收不到、也唤不醒**模型
- 群里只在 **@ 它** 或 **回复它** 时才理人，其余只入库不烧 token
- 在线状态保持沉默、不自动标已读——不影响你手机和电脑上的显示
- 群 / 频道 / 机器人账号**不能发文件**；私聊发文件按你配置（允许 / 先问我 / 不允许）
- 发送路径限制在资源目录内，`session.txt` 与私钥一类文件永远发不出去
- 双开直接拒绝启动，会话失效/被封立即停机

### 需要准备

一个 Telegram 账号（手机能收验证码）、能访问 Telegram 的网络（走代理请开 TUN 模式）。

---

## English

### One-liner (market list / npm)

Use your **real Telegram account** inside Coopanion: messages, media and stickers — allowlist-gated, quiet by default, running alongside Desktop and mobile.

### Paragraph (detail page / README)

This is not a bot. It signs in as *you* over MTProto (not the Bot API), so the other side sees a real person and everything stays in your own account. With Coopanion attached, the model can read and answer messages, send files, post stickers, look up groups and forum topics — but only in conversations you allow, and by default it shows no presence, marks nothing read, and never reaches out on its own.

### What it does

- **Chats**: users, groups, channels, forum topics, members, common chats, contacts
- **Messages**: send, reply with quote, edit, delete, forward, react, mark read, search
- **Media**: photos, videos, files, albums; voice messages transcoded automatically; download and cache cleanup
- **Stickers & GIFs**: Telegram packs, a local sticker folder (webp/tgs/webm/gif/jpg handled by form), GIF search including Chinese queries
- **Singing**: a dedicated "song" folder for RVC-style covers — sent directly, no file approval
- **47 tools / 6 panels / 9 prompt variables**

### Safe by default

- **Allowlist**: anyone outside it can't reach the model — no event, no media download, no wake-up
- **In groups** it only responds when **mentioned** or **replied to**; everything else is recorded without spending tokens
- **Presence stays silent**, no auto mark-as-read — your phone and desktop are unaffected
- **Groups, channels and bot accounts can never receive files**; in private chats file sending follows your setting (allow / ask me / never)
- **Send paths** are limited to resource folders; `session.txt` and private keys can never be sent
- **Double-start is refused**; revoked sessions or banned accounts stop the client immediately

### Requirements

A Telegram account (able to receive the login code) and a network that can reach Telegram (if you use a proxy, enable TUN mode).

---

## 日本語

### 一行版（マーケット一覧 / npm）

Coopanion から、あなた自身の **Telegram 個人アカウント**でメッセージ・メディア・スタンプをやり取り。許可リスト制・既定はサイレント。デスクトップ版やスマホと同時に使えます。

### 段落版（詳細ページ / README）

これは Bot ではありません。MTProto で**あなた自身**として接続するため、相手に見えるのは real な個人アカウントで、履歴もあなたのアカウントに残ります。Coopanion と組み合わせると、メッセージの読み書き、ファイル送信、スタンプ、グループやフォーラム話題の検索まで行えますが、**許可した会話だけ**が対象で、既定ではオンライン表示も既読もしません。

### できること

- **会話**：ユーザー / グループ / チャンネル / フォーラム話題 / メンバー / 共通グループ / 連絡先
- **メッセージ**：送信・引用返信・編集・削除・転送・リアクション・既読・検索
- **メディア**：画像・動画・ファイル・アルバム。ボイスは自動変換。ダウンロードとキャッシュ整理
- **スタンプと GIF**：Telegram パック、ローカルのスタンプフォルダ（webp/tgs/webm/gif/jpg を自動判別）、中国語での GIF 検索
- **歌**：RVC などのカバー音源用に「唱歌フォルダ」を用意。ファイル承認なしで送信
- **ツール 47 個 / パネル 6 枚 / テンプレート変数 9 個**

### 安全な初期設定

- **許可リスト制**：リスト外の相手はモデルに届きません（イベントも作らず、メディアも落とさない）
- **グループでは**「@ で呼ばれた」「返信された」ときだけ反応。それ以外は記録のみでトークンを使いません
- **オンライン状態はサイレント**、自動既読もしません — スマホや PC の表示は変わりません
- **グループ / チャンネル / Bot アカウントにはファイルを送れません**。個人チャットは設定に従います（許可 / 確認 / 禁止）
- **送信パス**はリソースフォルダ内に限定。`session.txt` や秘密鍵は絶対に送信できません
- **二重起動は拒否**、セッション失効やアカウント停止時は即座に停止します

### 必要なもの

Telegram アカウント（認証コードを受け取れること）と、Telegram に到達できるネットワーク（プロキシを使う場合は TUN モードを有効に）。
