/**
 * WorldDefinition：Coopanion 装载的就是这个对象。
 * 契约：`world.id / label / defaults() / preflight?() / create(ctx) / describe?`。
 */

import type { DescribeText, ToolDescribe } from 'cortico/core/types.ts';
import type { WorldDefinition } from 'cortico/world.ts';

import { telegramDefaults, type TelegramConfigSection } from './config.ts';
import { resolveCredentials } from './mtproto/credentials.ts';
import { TELEGRAM_TOOL_DECLS } from './tools.ts';
import { TelegramWorld } from './world.ts';

/**
 * 自描述工具表。
 *
 * 框架有 `describeTools()`，但那是**运行时值**导入——用了它，整个包就无法脱离 Coopanion 被 import，
 * 连离线冒烟测试都跑不了。这里按同一契约自己拼，字段与 `cortico/world.ts` 的实现一致。
 */
function describeAll(
  decls: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown>; tags: readonly ToolDescribe['tags'][number][] }>,
  summaries: Readonly<Record<string, DescribeText>>,
): ToolDescribe[] {
  return decls.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    ...(summaries[name] ? { summary: summaries[name] } : {}),
  }));
}

export const TELEGRAM: WorldDefinition<TelegramConfigSection> = {
  id: 'telegram',
  label: 'Telegram',

  defaults: () => telegramDefaults(),

  /** 激活前就把凭据问题挡住，别等 start() 才炸。 */
  preflight: (ctx) => {
    const resolved = resolveCredentials({ apiId: ctx.cfg.apiId, apiHash: ctx.cfg.apiHash });
    if (!resolved.ok) {
      throw new Error(`${resolved.error}${resolved.detail ? `：${resolved.detail}` : ''}`);
    }
  },

  create: (ctx) => new TelegramWorld(ctx),

  describe: {
    tools: describeAll(TELEGRAM_TOOL_DECLS, {
      telegram_status: {
        zh: '查当前 Telegram 账号、连接状态与监听白名单。',
        en: 'Reports the bound Telegram account, connection state and watch list.',
      },
      telegram_list_chats: {
        zh: '列出最近会话（名称、@用户名、id、类型、未读），用于按名字找人。',
        en: 'Lists recent conversations with names, usernames, ids, kinds and unread counts.',
      },
      telegram_search_chats: {
        zh: '按名字、@用户名或 t.me 链接搜会话与联系人，返回候选项。',
        en: 'Searches conversations and contacts by name, username or t.me link.',
      },
      telegram_get_chat_info: {
        zh: '查一个用户/群/频道的资料：名称、用户名、简介、成员数、是否论坛。',
        en: 'Shows one chat/user/channel profile.',
      },
      telegram_get_forum_topics: {
        zh: '列超级群的论坛话题（话题 id 就是发消息时要填的 topic）。',
        en: 'Lists forum topics; the topic id is what you pass as `topic` when sending.',
      },
      telegram_get_contacts: {
        zh: '列账号联系人（名字、@用户名、id、手机号）。',
        en: 'Lists account contacts.',
      },
      telegram_get_user_info: {
        zh: '看一个用户的资料：名字、用户名、简介、共同群数（隐私限制的字段不出现）。',
        en: 'Shows one user profile, including shared-group count.',
      },
      telegram_get_common_chats: {
        zh: '看和某个人的共同群 / 频道。',
        en: 'Lists groups shared with one user.',
      },
      telegram_add_contact: {
        zh: '把某个用户存进联系人。',
        en: 'Saves a user into contacts.',
      },
      telegram_delete_contact: {
        zh: '从联系人里删掉某个用户（不拉黑）。',
        en: 'Removes a user from contacts (no block).',
      },
      telegram_block_user: {
        zh: '拉黑一个人（最后手段，对方将无法再发消息）。',
        en: 'Blocks a user as a last resort.',
      },
      telegram_unblock_user: {
        zh: '解除拉黑。',
        en: 'Undoes a block.',
      },
      telegram_get_blocked: {
        zh: '列已拉黑名单。',
        en: 'Lists blocked users.',
      },
      telegram_mute_chat: {
        zh: '静音会话（0=取消，-1=永久，N=分钟）——比拉黑软得多。',
        en: 'Mutes/unmutes a chat; much softer than blocking.',
      },
      telegram_notify_owner: {
        zh: '把一条消息转告主人（目标固定，模型改不了；每小时 10 条）。',
        en: 'Reports something to the owner private chat (fixed target, rate limited).',
      },
      telegram_get_participants: {
        zh: '列群成员/频道订阅者，支持分页、只看管理员、按名字搜。',
        en: 'Lists members with paging, admins-only and name search.',
      },
      telegram_send_message: {
        zh: '以本账号向指定会话发一条文字消息（可引用回复）。',
        en: 'Sends a text message as this account, optionally quoting a message.',
      },
      telegram_read_messages: {
        zh: '读某个会话最近的消息（发信人、时间、正文、媒体类型）。',
        en: 'Reads recent messages from one chat with sender, time, text and media kind.',
      },
      telegram_search_messages: {
        zh: '在某个会话里按关键词搜消息，返回真实 chat_id / message_id。',
        en: 'Searches message text inside one chat and returns real chat_id / message_id.',
      },
      telegram_get_message: {
        zh: '按 id 取单条消息，含媒体信息与回复关系。',
        en: 'Fetches one message by id with media info and reply relationship.',
      },
      telegram_edit_message: {
        zh: '编辑自己发过的消息（Telegram 限制约 48 小时内）。',
        en: 'Edits a message this account sent (within ~48h).',
      },
      telegram_delete_message: {
        zh: '删除消息；默认需要真人回「!ok 码」批准。',
        en: 'Deletes messages; needs user approval (!ok CODE) by default.',
      },
      telegram_forward_messages: {
        zh: '把消息转发到别的会话；转出白名单需要审批。',
        en: 'Forwards messages; forwarding outside the allow list needs approval.',
      },
      telegram_send_reaction: {
        zh: '给某条消息加一个 emoji 反应。',
        en: 'Reacts to a message with one emoji.',
      },
      telegram_mark_read: {
        zh: '标记会话已读（账号级，会消掉电脑版 / 手机版上的未读红点）。',
        en: 'Marks a chat read (account-wide; clears Desktop unread badges).',
      },
      telegram_search_stickers: {
        zh: '按文字或 emoji 搜表情包（sticker set）。',
        en: 'Searches sticker sets by keyword or emoji.',
      },
      telegram_get_sticker_set: {
        zh: '列出一个表情包里的贴纸（序号、emoji、格式）。',
        en: 'Lists the stickers in one pack with index, emoji and mime.',
      },
      telegram_search_gifs: {
        zh: '用 @gif 内联机器人搜 GIF 动图（中文也能搜）。',
        en: "Searches GIFs through the @gif inline bot (Chinese works).",
      },
      telegram_send_gif: {
        zh: '发送搜到的某个 GIF（按序号）。',
        en: 'Sends one GIF by index.',
      },
      telegram_tag_local_stickers: {
        zh: '给本地表情打语义标签（看图 → 写关键词和适用场景），之后能按意思挑。',
        en: 'Tags local stickers with meaning so they can be picked by intent.',
      },
      telegram_list_stickers: {
        zh: '列出可用的表情来源：本地表情包目录 + Telegram 已装包。',
        en: 'Lists sticker sources: the local folder plus installed Telegram packs.',
      },
      telegram_send_sticker: {
        zh: '发一个表情：来自 Telegram 包（序号/emoji）或本地表情包目录的文件。',
        en: 'Sends one sticker from a pack or from a local file.',
      },
      telegram_fave_sticker: {
        zh: '收藏 / 取消收藏单个贴纸。',
        en: 'Adds or removes one sticker from favourites.',
      },
      telegram_install_sticker_set: {
        zh: '安装 / 卸载表情包。',
        en: 'Installs or uninstalls a sticker pack.',
      },
      telegram_get_favorite_stickers: {
        zh: '列出账号里收藏的贴纸（账号级，不分会话）。',
        en: 'Lists stickers favourited by this account.',
      },
      telegram_get_installed_stickers: {
        zh: '列出已安装的表情包。',
        en: 'Lists installed sticker packs.',
      },
      telegram_download_media: {
        zh: '把某条消息里的图片/视频/语音/文件下载到本地；图片会顺便附给你看。',
        en: "Downloads one message's media; images are attached so the model can see them.",
      },
      telegram_find_local_media: {
        zh: '在配置的资源目录里找最近生成的语音/图片/视频/文件。',
        en: 'Finds recently generated local media in the configured resource directories.',
      },
      telegram_register_local_media: {
        zh: '登记别的 World 产出的文件（必须在授权目录内）。',
        en: 'Registers a file produced by another world (must live inside an authorized directory).',
      },
      telegram_pin_message: {
        zh: '置顶 / 取消置顶一条消息（私聊会对双方生效）。',
        en: 'Pins or unpins one message.',
      },
      telegram_archive_chat: {
        zh: '归档 / 取消归档一个会话。',
        en: 'Archives or unarchives a chat.',
      },
      telegram_save_message: {
        zh: '把某条消息转存到 Saved Messages。',
        en: 'Saves a message into Saved Messages.',
      },
      telegram_get_reactions: {
        zh: '看一条消息上的反应明细（谁、什么 emoji）。',
        en: 'Shows who reacted to a message and with what.',
      },
      telegram_get_folders: {
        zh: '列聊天文件夹。',
        en: 'Lists chat folders.',
      },
      telegram_cleanup_media: {
        zh: '清理下载下来的媒体缓存（可按小时，也可全清）。不碰你配置的素材目录。',
        en: 'Cleans the downloaded-media cache (by age, or everything).',
      },
      telegram_send_album: {
        zh: '一次发 2–10 张图（相册）。',
        en: 'Sends 2–10 photos as one album.',
      },
      telegram_send_media: {
        zh: '把本地文件以本账号发出去（图片/视频/音频/文件，可当语音条）。',
        en: 'Sends a local file as this account, optionally as a voice message.',
      },
    }),
    events: [
      {
        type: 'telegram.message',
        description: {
          zh: '白名单会话里有人发来消息（私聊立即投递，群/频道合批）。',
          en: 'A message arrived in a watched chat; delivered at once for private chats.',
        },
        trigger: 'flush',
      },
      {
        type: 'telegram.self',
        description: {
          zh: '你在手机版 / 电脑版上发出的消息，只归档、不唤醒。',
          en: "Messages sent by this account (including Desktop/mobile); archived without waking the model.",
        },
        trigger: 'piggyback',
      },
    ],
  },
};
