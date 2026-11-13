/**
 * S-11：可选审计日志。
 *
 * 目的：出问题时能回答"什么时候、谁让它、用什么工具、发了什么"。
 * 默认**关闭**——它会记下操作内容，不是所有人都想留痕。
 *
 * 约定：
 *  - JSONL（一行一条），方便 grep / 用脚本统计
 *  - 参数与正文都**脱敏 + 截断**，不写 session、api_hash、手机号
 *  - 文件 0600，超过上限轮转一份（`audit.1.jsonl`），不全量保留
 */

import { appendFileSync, chmodSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface AuditEntry {
  /** 工具名，例如 `telegram_send_message`。 */
  tool: string;
  /** done / denied / pending / failed。 */
  result: string;
  /** 目标会话 id（有就记）。 */
  chatId?: number;
  /** 参数摘要（已脱敏、已截断）。 */
  args?: string;
  /** 回执摘要（已脱敏、已截断）。 */
  outcome?: string;
  /** 审批码（如果这条是待批准）。 */
  approval?: string;
}

export interface AuditOptions {
  maxBytes?: number;
  now?: () => number;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // 形似 session 串（很长、base64 风格）与 api_hash（32 位十六进制）
  [/\b[A-Za-z0-9+/=_-]{40,}\b/g, '[redacted-session]'],
  [/\b[a-f0-9]{32}\b/gi, '[redacted-hash]'],
  // 手机号（+86 138… / 纯 11 位）
  [/(\+\d{1,3}[\s-]?)?\d{11}\b/g, '[redacted-phone]'],
  // 明确的键值对
  [/(api_hash|apiHash|session|password)\s*[=:]\s*\S+/gi, '$1=[redacted]'],
];

/** 脱敏：把看起来像密钥/手机号的东西换掉。 */
export function redactAudit(text: string): string {
  let out = text ?? '';
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** 压成一行并截断（审计日志不需要完整正文）。 */
export function compactAudit(text: unknown, max = 240): string {
  const raw = typeof text === 'string' ? text : safeStringify(text);
  const flat = redactAudit(raw).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export class AuditLog {
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(
    private readonly file: string,
    enabled: boolean,
    opts: AuditOptions = {},
  ) {
    this.enabledFlag = enabled;
    this.maxBytes = Math.max(64 * 1024, opts.maxBytes ?? 5 * 1024 * 1024);
    this.now = opts.now ?? (() => Date.now());
  }

  private enabledFlag: boolean;

  get isEnabled(): boolean {
    return this.enabledFlag;
  }

  /** 运行中开关（配置改了不用重启）。 */
  setEnabled(value: boolean): void {
    this.enabledFlag = value;
  }

  get path(): string {
    return this.file;
  }

  /** 记一条。失败静默——审计日志不能影响正常收发。 */
  write(entry: AuditEntry): void {
    if (!this.enabledFlag) return;
    const line = JSON.stringify({
      ts: new Date(this.now()).toISOString(),
      tool: entry.tool,
      result: entry.result,
      ...(entry.chatId !== undefined ? { chat_id: entry.chatId } : {}),
      ...(entry.args ? { args: compactAudit(entry.args) } : {}),
      ...(entry.outcome ? { outcome: compactAudit(entry.outcome) } : {}),
      ...(entry.approval ? { approval: entry.approval } : {}),
    });
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      if (!existsSync(this.file)) {
        writeFileSync(this.file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
        try {
          chmodSync(this.file, 0o600);
        } catch {
          // Windows 上 chmod 只影响只读位
        }
        return;
      }
      appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch {
      // 磁盘满 / 权限不足：静默放弃
    }
  }

  /** 超过上限就换名保留一份，避免无限增长。 */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file)) return;
      if (statSync(this.file).size < this.maxBytes) return;
      const backup = `${this.file}.1`;
      if (existsSync(backup)) {
        try {
          unlinkSync(backup);
        } catch {
          // 删不掉就覆盖写
        }
      }
      renameSync(this.file, backup);
    } catch {
      // 轮转失败不影响写入
    }
  }
}
