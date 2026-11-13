/**
 * 高危操作审批（PLAN §13.5 的落地）。
 *
 * 关键区分：
 *  - **模型自查** = Agent 自己判断参数对不对（`telegram_confirm` 那类），不代表用户同意。
 *  - **用户授权** = 真人回一句 `!ok CODE` 才执行；一次一码，绑定目标与内容。
 *
 * 规则（规划 §15）：
 *  - 审批码只批准**对应的那一次**操作，用完即焚；
 *  - 目标或内容变了必须重新审批（码绑定的是闭包，不是「这类操作」）；
 *  - 5 分钟过期；
 *  - 码不能当短期通用授权。
 */

export type RiskKind = 'delete' | 'forward' | 'send_outside' | 'contact_write' | 'sticker_set' | 'send_file';

export type GuardPolicy = 'auto' | 'ask' | 'deny';

export interface ApprovalRequest {
  code: string;
  kind: RiskKind;
  /** 人话摘要，给用户看。 */
  summary: string;
  /** 目标会话。 */
  target: string;
  createdAt: number;
  expiresAt: number;
  /** 批准后真正执行；返回值是回执文本。 */
  run: () => Promise<string>;
}

/** 去掉容易看错的 0/O/1/I。 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeApprovalCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? 'A';
  }
  return out;
}

export interface ApprovalsOptions {
  ttlMs?: number;
  now?: () => number;
  random?: () => number;
}

export class Approvals {
  private readonly items = new Map<string, ApprovalRequest>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(opts: ApprovalsOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  /** 登记一次待批准操作，返回带码的请求。 */
  request(kind: RiskKind, summary: string, target: string, run: () => Promise<string>): ApprovalRequest {
    this.purge();
    let code = makeApprovalCode(this.random);
    for (let attempt = 0; attempt < 8 && this.items.has(code); attempt += 1) {
      code = makeApprovalCode(this.random);
    }
    const at = this.now();
    const request: ApprovalRequest = {
      code,
      kind,
      summary,
      target,
      createdAt: at,
      expiresAt: at + this.ttlMs,
      run,
    };
    this.items.set(code, request);
    return request;
  }

  /** 取出并删除（一次性）。过期返回 null。 */
  take(code: string): ApprovalRequest | null {
    const key = code.trim().toUpperCase();
    const item = this.items.get(key);
    if (!item) return null;
    this.items.delete(key);
    if (this.now() > item.expiresAt) return null;
    return item;
  }

  /** 只查不取。 */
  peek(code: string): ApprovalRequest | null {
    const item = this.items.get(code.trim().toUpperCase());
    if (!item) return null;
    return this.now() > item.expiresAt ? null : item;
  }

  cancel(code: string): boolean {
    return this.items.delete(code.trim().toUpperCase());
  }

  /** 最近一条待批准（人话回复时按它处理）。 */
  latest(): ApprovalRequest | null {
    this.purge();
    let newest: ApprovalRequest | null = null;
    for (const item of this.items.values()) {
      if (!newest || item.createdAt > newest.createdAt) newest = item;
    }
    return newest;
  }

  list(): ApprovalRequest[] {
    this.purge();
    return [...this.items.values()];
  }

  purge(): void {
    const at = this.now();
    for (const [code, item] of this.items) {
      if (at > item.expiresAt) this.items.delete(code);
    }
  }

  size(): number {
    this.purge();
    return this.items.size;
  }
}

/** 解析 `!ok A7F3` / `!no a7f3` / `!ok`（不带码时列清单）。 */
export function parseApprovalCommand(text: string): { decision: 'ok' | 'no' | 'list'; code?: string } | null {
  const value = text.trim();
  if (!/^!(ok|no|list)\b/i.test(value)) return null;
  const match = /^!(ok|no|list)\s*([A-Za-z0-9]{0,8})?/i.exec(value);
  if (!match) return null;
  const decision = match[1]?.toLowerCase() as 'ok' | 'no' | 'list';
  const code = match[2]?.trim();
  return { decision, ...(code ? { code: code.toUpperCase() } : {}) };
}

/** 给用户看的待批准清单。 */
export function renderApprovals(list: ApprovalRequest[]): string {
  if (!list.length) return '没有待批准的操作。';
  return [
    `待批准 ${list.length} 项：`,
    ...list.map((item) => `- ${item.code}｜${item.summary}（${Math.max(0, Math.round((item.expiresAt - Date.now()) / 1000))}s 后过期）`),
    '回复「!ok 码」批准，或「!no 码」取消。',
  ].join('\n');
}

/**
 * 认主人的**大白话**回复。
 *
 * 不再要求 `!ok CODE`：主人怎么顺口怎么回。
 *  - allow   ：可以 / 行 / 发吧 / 没问题 / ok
 *  - deny    ：不行 / 别 / 算了 / 不要 / no
 *  - delegate：随便你 / 你看着办 / 你决定 —— 等于"你自己判断"
 * 认不出返回 null（那就当普通聊天，不碰审批）。
 */
export type OwnerReply = 'allow' | 'deny' | 'delegate';

const ALLOW_WORDS = [
  '可以', '行', '好', '好的', '嗯', '发吧', '发', '给吧', '给他', '给她', '同意', '批准', '没问题',
  'ok', 'okay', 'yes', 'sure', 'fine',
  '发给他', '发给她', '发过去', '去吧', '干吧', '做吧',
];
const DENY_WORDS = [
  '不行', '不可以', '不要', '不用', '不必', '别', '别发', '算了', '不给', '不许', '不准', '拒绝', '收回',
  'no', 'nope', 'stop', 'cancel',
];
const DELEGATE_WORDS = [
  '随便你', '随你', '你看着办', '你定', '你决定', '你说了算', '看你', '你拿主意', '你自己决定', '随意',
  'up to you', 'your call', 'whatever',
];

export function classifyOwnerReply(text: string): OwnerReply | null {
  const raw = (text ?? '').trim().toLowerCase();
  if (!raw) return null;
  // 去掉标点与空白，只比字面意思
  const flat = raw.replace(/[\s，。！？、,.!?~…"'“”‘’()（）]/g, '');
  if (!flat) return null;
  // 太长的当普通聊天，不碰审批（避免"我觉得可以但……"误判成同意）
  if (flat.length > 24) return null;
  // 问句一律不当成决定：「你觉得可以吗」「能发吗」
  if (/[吗么呢]$/.test(flat) || /[?？]$/.test(raw)) return null;

  if (DELEGATE_WORDS.some((word) => flat.includes(word.replace(/\s+/g, '')))) return 'delegate';

  // allow / deny 只认短回复：一句长话里的"可以"多半是闲聊
  if (flat.length <= 10) {
    if (DENY_WORDS.some((word) => flat.includes(word.replace(/\s+/g, '')))) return 'deny';
    if (ALLOW_WORDS.some((word) => flat.includes(word.replace(/\s+/g, '')))) return 'allow';
  }
  return null;
}