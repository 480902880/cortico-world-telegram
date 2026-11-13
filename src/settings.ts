/**
 * 「行为」页的字段表。
 *
 * 目的：把散在 `worlds.telegram.*` 里的开关搬到界面上，省得手改 JSON。
 * 这里只做**声明 + 取值 + 校验**，持久化交给 World（它才知道 ctx.persist 怎么写）。
 */

import type { TelegramConfigSection } from './config.ts';

export type FieldType = 'bool' | 'int' | 'enum';

export interface SettingField {
  key: string;
  group: string;
  label: string;
  hint?: string;
  type: FieldType;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
  /**
   * 显示单位与存储单位的换算倍数。
   * 例：`maxMediaBytes` 存字节，界面按 MB 显示 → scale = 1024*1024。
   */
  scale?: number;
}

const GUARD_LABELS: Array<{ key: keyof TelegramConfigSection['guard']; label: string; hint?: string }> = [
  { key: 'deleteRevoke', label: '删除消息' },


  { key: 'contactWrite', label: '增删联系人' },
  { key: 'blockUser', label: '拉黑' },
];

/** 需要人工拍板的动作：ask / auto / deny。 */
export const GUARD_POLICIES = ['ask', 'auto', 'deny'] as const;

export function behaviorFields(zh: boolean): SettingField[] {
  const t = (cn: string, en?: string): string => (zh ? cn : (en ?? cn));
  const guardField = (key: string, label: string, extra?: string): SettingField => ({
    key: `guard.${key}`,
    group: t('敏感操作的确认', 'Confirmations'),
    label,
    hint: t('允许＝可以做（做不做仍由它自己判断）；先问我＝在 Telegram 回 !ok 才做；不允许＝一律拒绝', 'Allowed (still its own call) / wait for !ok / never')
      + (extra ? `。${extra}` : ''),
    type: 'enum',
    options: [
      { value: 'auto', label: t('允许（不询问）', 'Allowed') },
      { value: 'ask', label: t('先问我', 'Ask me') },
      { value: 'deny', label: t('不允许', 'Never') },
    ],
  });

  return [
    {
      key: 'ownerUserId',
      group: t('主人', 'Owner'),
      label: t('主人 Telegram ID（可留空）'),
      hint: t(
        '留空 = 由 bot 自己判断（它记得谁是主人）；填了才指定审批与告警的收件账号；填错不影响它认人',
        'Empty = the bot decides on its own; filled = fixed recipient for approvals and alerts',
      ),
      type: 'int',
      min: 0,
      max: 9_999_999_999,
    },



    {
      key: 'watchSelf',
      group: t('监听范围', 'What to watch'),
      label: t('你在手机版 / 电脑版上发的消息', 'Messages you send from other devices'),
      hint: t('同一个账号，但不是 bot 自身发出去的消息。忽略＝完全不看；只记录＝存下来但不唤醒模型；照常处理＝当成别人发来的消息', 'Same account, but not sent by the bot itself: ignore / store only / treat as incoming'),
      type: 'enum',
      options: [
        { value: 'off', label: t('忽略', 'Ignore') },
        { value: 'record', label: t('只记录（不唤醒）', 'Record only') },
        { value: 'echo', label: t('照常处理（会接话）', 'Treat as incoming') },
      ],
    },
    {
      key: 'groupTrigger',
      group: t('监听范围', 'What to watch'),
      label: t('群里什么时候理人'),
      hint: t('被 @ 或回复它才唤醒；其余消息照样入库但不叫模型，省 token', 'Only wake on mention or reply; other messages are recorded silently'),
      type: 'enum',
      options: [
        { value: 'mention_or_reply', label: t('@ 或回复（推荐）', 'Mention or reply') },
        { value: 'mention', label: t('只认 @', 'Mention only') },
        { value: 'allowed_senders', label: t('只认白名单里那个人', 'Allowed senders only') },
        { value: 'all', label: t('每条都理（费 token）', 'Every message') },
      ],
    },
    {
      key: 'catchUp',
      group: t('监听范围', 'What to watch'),
      label: t('断线补课'),
      hint: t('重连后把漏掉的消息补回来（消息级）', 'Backfill missed messages after reconnect'),
      type: 'bool',
    },
    {
      key: 'autoImages',
      group: t('媒体', 'Media'),
      label: t('图片自动附给模型'),
      hint: t('关掉后模型只能看到 [图片] 占位', 'Off: the model only sees a [photo] placeholder'),
      type: 'bool',
    },
    {
      key: 'autoThumbnails',
      group: t('媒体', 'Media'),
      label: t('视频/文件附缩略图'),
      hint: t('不下整段视频，只取预览帧', 'Thumbnail only, never the whole video'),
      type: 'bool',
    },
    {
      key: 'maxMediaBytes',
      group: t('媒体', 'Media'),
      label: t('附件体积上限'),
      hint: t('按 MB 取整；超过这个大小的媒体不会自动附给模型', 'Rounded to whole MB'),
      type: 'int',
      min: 1,
      max: 100,
      unit: 'MB',
      scale: 1024 * 1024,
    },
    {
      key: 'presence',
      group: t('隐私', 'Privacy'),
      label: t('在线状态'),
      hint: t('保持沉默＝完全不调接口改状态，手机/桌面该怎样还怎样（推荐）；显示在线＝插件运行期间每 60 秒上报一次在线，退出时只把这条连接标为离线', 'Silent never touches your status; online pings once a minute while running'),
      type: 'enum',
      options: [
        { value: 'silent', label: t('保持沉默', 'Stay silent') },
        { value: 'onlineWhileRunning', label: t('显示在线', 'Appear online') },
      ],
    },
    {
      key: 'autoMarkRead',
      group: t('隐私', 'Privacy'),
      label: t('自动标为已读'),
      hint: t('开了以后，插件收到的消息会被标已读，手机/桌面上的未读红点会一起消失；关着则完全不动', 'Marks incoming messages read (clears badges on your other devices)'),
      type: 'bool',
    },
    {
      key: 'typingIndicator',
      group: t('隐私', 'Privacy'),
      label: t('回复前显示「正在输入」'),
      hint: t('发消息前先上报一次 typing 动作，对方会看到「正在输入…」；只在发文字时触发', 'Show a typing indicator right before sending text'),
      type: 'bool',
    },
    {
      key: 'auditLog',
      group: t('隐私', 'Privacy'),
      label: t('审计日志（记录工具调用）'),
      hint: t('开启后把「哪个工具、参数摘要、结果」写到 data/telegram/audit.jsonl（已脱敏；单个文件超过 5 MB 轮转一份）。默认关', 'Log tool calls to audit.jsonl (redacted, rotated at 5 MB). Off by default'),
      type: 'bool',
    },
    {
      key: 'panelHistoryLimit',
      group: t('消息合并', 'Batching'),
      label: t('会话页默认历史条数'),
      hint: t('双击会话时展开多少条（10–900）', 'How many messages to show on double-click'),
      type: 'int',
      min: 10,
      max: 900,
      unit: t('条', 'msgs'),
    },
    {
      key: 'mergeWindowMs',
      group: t('消息合并', 'Batching'),
      label: t('合并窗口'),
      hint: t('同一会话连发时，这个窗口内的消息合成一条事件；0 = 逐条投递。攒满 10 条或从第一条起超过 8 秒会立刻投递', '0 = deliver each message'),
      type: 'int',
      min: 0,
      max: 15_000,
      unit: 'ms',
    },
    {
      key: 'fileByWhitelisted',
      group: t('敏感操作的确认', 'Confirmations'),
      label: t('白名单私聊发文件（个人材料）'),
      // 默认「允许」：主人要东西不该被拦；其余由 bot 自己按意愿判断
      hint: t('默认允许（主人要东西不该被拦）。群、频道、TG 机器人账号一律不能发文件；表情/贴纸/GIF/语音不受限', 'Allowed by default; groups and bots never get files'),
      type: 'enum',
      options: [
        { value: 'auto', label: t('允许（不询问）', 'Allowed') },
        { value: 'ask', label: t('先问我', 'Ask me') },
        { value: 'deny', label: t('不允许', 'Never') },
      ],
    },
    ...GUARD_LABELS.map((item) => guardField(String(item.key), item.label, item.hint)),
  ];
}

/** 从当前配置里取这些字段的值。 */
export function behaviorValues(cfg: TelegramConfigSection, zh: boolean): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of behaviorFields(zh)) {
    if (field.key.startsWith('guard.')) {
      const key = field.key.slice('guard.'.length) as keyof TelegramConfigSection['guard'];
      values[field.key] = cfg.guard?.[key] ?? 'auto';
    } else {
      const raw = (cfg as unknown as Record<string, unknown>)[field.key];
      // 有换算倍数就按显示单位返回（例：字节 → MB）
      if (field.scale && typeof raw === 'number') {
        values[field.key] = Math.max(1, Math.round(raw / field.scale));
      } else {
        values[field.key] = raw;
      }
    }
  }
  return values;
}

/**
 * 校验并规整补丁。
 * 返回 `{ config }`（普通字段）与 `{ guard }`（策略字段）——调用方分别持久化。
 */
export function applyBehaviorPatch(
  patch: Record<string, unknown>,
  zh: boolean,
): { config: Record<string, unknown>; guard: Record<string, string>; changed: string[] } {
  const fields = new Map(behaviorFields(zh).map((field) => [field.key, field]));
  const config: Record<string, unknown> = {};
  const guard: Record<string, string> = {};
  const changed: string[] = [];

  for (const [key, raw] of Object.entries(patch ?? {})) {
    const field = fields.get(key);
    if (!field) continue; // 不在白名单里的键一律忽略

    if (field.type === 'bool') {
      const value = raw === true || raw === 'true' || raw === 1;
      if (field.key.startsWith('guard.')) guard[field.key.slice(6)] = value ? 'auto' : 'deny';
      else config[field.key] = value;
      changed.push(`${field.label} = ${value ? '开' : '关'}`);
      continue;
    }

    if (field.type === 'int') {
      const value = Math.round(Number(raw));
      if (!Number.isFinite(value)) throw new Error(`${field.label}：需要数字`);
      const min = field.min ?? Number.MIN_SAFE_INTEGER;
      const max = field.max ?? Number.MAX_SAFE_INTEGER;
      const clamped = Math.min(max, Math.max(min, value));
      // 界面单位 → 存储单位（例：MB → 字节）
      config[field.key] = field.scale ? clamped * field.scale : clamped;
      changed.push(`${field.label} = ${clamped}${field.unit ? ` ${field.unit}` : ''}`);
      continue;
    }

    const value = String(raw ?? '');
    const allowed = (field.options ?? []).map((option) => option.value);
    if (!allowed.includes(value)) throw new Error(`${field.label}：只能是 ${allowed.join(' / ')}`);
    if (field.key.startsWith('guard.')) {
      guard[field.key.slice(6)] = value;
      changed.push(`${field.label} = ${value}`);
    } else {
      config[field.key] = value;
      const label = field.options?.find((option) => option.value === value)?.label ?? value;
      changed.push(`${field.label} = ${label}`);
    }
  }

  return { config, guard, changed };
}
