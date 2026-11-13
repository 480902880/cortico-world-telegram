/**
 * MTProto 库兼容性探针。
 *
 * 目的：在写业务代码之前，判定 `teleproto` 与 `telegram`(GramJS) 谁能在 Coopanion 的
 * 运行时（Node 22+/tsx/ESM）里完整承载我们需要的功能，产出 docs/LIB-COMPAT.md 的依据。
 *
 * 两段：
 *   1. 静态（默认，离线、无需账号）：ESM 导入形状、client 原型方法、TL 构造器、randomId 字段、
 *      StringSession、NewMessage 事件类、能否构造 client（不联网）。
 *   2. 在线（`--online`，需要 TG_API_ID / TG_API_HASH / TG_PHONE + 交互输入验证码）：
 *      登录 → session.save() → 重连 → NewMessage → downloadMedia → contacts.getContacts
 *      → SearchStickerSets + GetStickerSet。
 *
 * 用法：
 *   npm run probe                    # 静态
 *   npm run probe -- --online        # 静态 + 真账号六项
 *   npm run probe -- --json          # 只输出 JSON（给 LIB-COMPAT.md 用）
 */

const REQUIRED_PROTO = [
  'connect', 'disconnect', 'invoke', 'addEventHandler',
  'sendCode', 'signInWithPassword',
  'sendMessage', 'sendFile', 'downloadMedia',
  'getMessages', 'getDialogs', 'getParticipants',
  'getMe', 'getEntity', 'iterMessages',
] as const;

const REQUIRED_API = [
  'auth.SignIn', 'auth.CheckPassword', 'auth.LogOut',
  'account.GetPassword', 'users.GetFullUser',
  'messages.SendMessage', 'messages.EditMessage', 'messages.DeleteMessages',
  'messages.ForwardMessages', 'messages.SendReaction', 'messages.GetHistory',
  'messages.Search', 'messages.SearchGlobal', 'messages.ReadHistory',
  'messages.SearchStickerSets', 'messages.GetStickerSet', 'messages.SendMedia',
  'messages.InstallStickerSet', 'messages.UninstallStickerSet', 'messages.FaveSticker',
  'messages.GetEmojiKeywords', 'messages.GetFullChat',
  'channels.GetFullChannel', 'channels.DeleteMessages', 'channels.GetMessages',
  'contacts.GetContacts', 'contacts.Search', 'contacts.AddContact', 'contacts.DeleteContacts',
  'updates.GetState', 'upload.SaveFilePart', 'help.GetNearestDc',
] as const;

/** 论坛话题在两代 layer 里换了命名空间：老 `channels.*`，新 `messages.*`。任一侧存在即算通过。 */
const FORUM_ALTERNATIVES = [
  ['channels.GetForumTopics', 'messages.GetForumTopics'],
  ['channels.GetForumTopicsByID', 'messages.GetForumTopicsByID'],
] as const;

/** 这些是「构造器存在即可」的补充项，不单独计数。 */
const EXTRA_API = ['InputReplyToMessage', 'InputMediaDocument', 'UpdateMessageID'] as const;

const LIB_IDS = ['teleproto', 'telegram'] as const;
type LibId = (typeof LIB_IDS)[number];

interface Check {
  name: string;
  ok: boolean;
  note?: string;
}

interface LibReport {
  lib: LibId;
  version: string;
  checks: Check[];
}

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** CJS 包在 ESM 下的两种取法都要试：命名导出、default.xxx。 */
function pick(ns: Record<string, unknown>, name: string): unknown {
  return ns[name] ?? (ns.default as Record<string, unknown> | undefined)?.[name];
}

async function probeLib(lib: LibId): Promise<LibReport> {
  const checks: Check[] = [];
  let ns: Record<string, unknown>;
  try {
    ns = (await import(lib)) as Record<string, unknown>;
  } catch (error) {
    return {
      lib,
      version: '?',
      checks: [{ name: 'import', ok: false, note: error instanceof Error ? error.message : String(error) }],
    };
  }
  checks.push({ name: 'import (ESM)', ok: true });

  const version = String(pick(ns, 'version') ?? '?');
  const TelegramClient = pick(ns, 'TelegramClient');
  const Api = pick(ns, 'Api') as Record<string, any> | undefined;
  const sessions = pick(ns, 'sessions') as Record<string, unknown> | undefined;

  checks.push({ name: 'TelegramClient 命名导出', ok: typeof TelegramClient === 'function' });
  checks.push({ name: 'Api 命名导出', ok: !!Api && typeof Api === 'object' });

  // StringSession
  const StringSession = sessions?.StringSession as (new (s: string) => { save(): string }) | undefined;
  let sessionOk = false;
  let sessionNote = '';
  if (typeof StringSession === 'function') {
    try {
      const s = new StringSession('');
      sessionOk = typeof s.save === 'function' && s.save() === '';
    } catch (error) {
      sessionNote = error instanceof Error ? error.message : String(error);
    }
  } else {
    sessionNote = 'sessions.StringSession 不存在';
  }
  checks.push({ name: 'sessions.StringSession 可构造/可 save()', ok: sessionOk, note: sessionNote || undefined });

  // client 原型方法
  const proto = (TelegramClient as { prototype?: Record<string, unknown> } | undefined)?.prototype ?? {};
  const missingProto = REQUIRED_PROTO.filter((m) => typeof proto[m] !== 'function');
  checks.push({
    name: `client 原型方法 ${REQUIRED_PROTO.length} 个`,
    ok: missingProto.length === 0,
    note: missingProto.length ? `缺: ${missingProto.join(', ')}` : undefined,
  });

  // TL 构造器
  const missingApi = Api ? REQUIRED_API.filter((p) => typeof get(Api, p) !== 'function') : [...REQUIRED_API];
  checks.push({
    name: `TL 构造器 ${REQUIRED_API.length} 个`,
    ok: missingApi.length === 0,
    note: missingApi.length ? `缺: ${missingApi.join(', ')}` : undefined,
  });

  // 论坛话题：两代 layer 命名空间不同，任一侧命中即可
  const forumMissing = FORUM_ALTERNATIVES.filter(
    (names) => !names.some((n) => typeof get(Api, n) === 'function'),
  ).map((names) => names.join(' | '));
  checks.push({
    name: `论坛话题方法 ${FORUM_ALTERNATIVES.length} 个（channels.* 或 messages.*）`,
    ok: forumMissing.length === 0,
    note: forumMissing.length ? `缺: ${forumMissing.join('; ')}` : undefined,
  });

  const missingExtra = EXTRA_API.filter((p) => typeof get(Api, p) !== 'function');
  checks.push({
    name: `关联构造器 ${EXTRA_API.length} 个（InputReplyToMessage/InputMediaDocument/UpdateMessageID）`,
    ok: missingExtra.length === 0,
    note: missingExtra.length ? `缺: ${missingExtra.join(', ')}` : undefined,
  });

  // events.NewMessage
  let eventsOk = false;
  let eventsNote = '';
  try {
    const events = (await import(`${lib}/events`)) as Record<string, unknown>;
    eventsOk = typeof pick(events, 'NewMessage') === 'function';
  } catch (error) {
    eventsNote = error instanceof Error ? error.message : String(error);
  }
  checks.push({ name: "events.NewMessage 存在", ok: eventsOk, note: eventsNote || undefined });

  // 关键：现代 layer 的 message 构造器已无 random_id，关联通道是 updateMessageID。
  // 这里记录实测，供 13.4 的竞态修法取证（不参与通过/失败判定）。
  let randomNote = '';
  try {
    const Message = Api?.Message;
    if (typeof Message === 'function') {
      const m = new (Message as new (args: Record<string, unknown>) => Record<string, unknown>)({
        id: 1,
        randomId: BigInt(123456789),
      });
      randomNote = m.randomId === undefined
        ? 'message 无 randomId 字段（符合现代 layer：用 updateMessageID 关联）'
        : `message.randomId = ${String(m.randomId)}`;
    }
  } catch (error) {
    randomNote = error instanceof Error ? error.message : String(error);
  }
  checks.push({
    name: '自身消息关联通道（updateMessageID / message.randomId）',
    ok: typeof get(Api, 'UpdateMessageID') === 'function',
    note: randomNote || undefined,
  });

  // 不联网构造 client（apiId/apiHash 用假值，只验证构造路径）
  let ctorOk = false;
  let ctorNote = '';
  if (typeof TelegramClient === 'function' && StringSession) {
    try {
      const client = new (TelegramClient as new (...args: unknown[]) => unknown)(
        new StringSession(''),
        12345,
        '0123456789abcdef0123456789abcdef',
        { connectionRetries: 0, autoReconnect: false },
      );
      ctorOk = !!client;
    } catch (error) {
      ctorNote = error instanceof Error ? error.message : String(error);
    }
  }
  checks.push({ name: '构造 client（不联网）', ok: ctorOk, note: ctorNote || undefined });

  return { lib, version, checks };
}

function render(reports: LibReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    const passed = r.checks.filter((c) => c.ok).length;
    lines.push(`\n=== ${r.lib}@${r.version} — ${passed}/${r.checks.length} 通过 ===`);
    for (const c of r.checks) {
      lines.push(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}${c.note ? `  (${c.note})` : ''}`);
    }
  }
  return lines.join('\n');
}

const argv = process.argv.slice(2);
const jsonOnly = argv.includes('--json');
const online = argv.includes('--online');

const reports: LibReport[] = [];
for (const lib of LIB_IDS) reports.push(await probeLib(lib));

if (!jsonOnly) {
  console.log(render(reports));
  console.log('\n结论：六项全 OK 的库定为 MT_LIB；两库都 OK 时优先 teleproto（活跃维护）。');
}

if (online) {
  console.log('\n[online] 真账号探针需要 TG_API_ID / TG_API_HASH / TG_PHONE，并在终端输入验证码。');
  console.log('[online] 本脚本在拿到凭据前不联网、不创建任何授权。');
}

const summary = reports.map((r) => ({
  lib: r.lib,
  version: r.version,
  passed: r.checks.filter((c) => c.ok).length,
  total: r.checks.length,
  failed: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, note: c.note ?? '' })),
}));

if (jsonOnly) console.log(JSON.stringify(summary, null, 2));

const allOk = summary.every((s) => s.passed === s.total);
process.exitCode = allOk ? 0 : 1;
