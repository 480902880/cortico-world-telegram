/**
 * api_id / api_hash 的解析与校验。
 *
 * 为什么必须有：MTProto 的 `auth.sendCode` 把 `api_id` 当协议字段发出去，
 * 没有它在协议层就登不进去——这不是实现缺失，是 Telegram 的硬要求。
 *
 * 解析优先级（三者只取其一，不混用）：
 *   1. 配置/面板填的（`worlds.telegram.apiId` + `apiHash`）
 *   2. 部署 `.env` 的 `TG_API_ID` + `TG_API_HASH`
 *   3. 内置默认（Telegram Desktop 的公开凭据）——**能立刻登录，但不是长久之计**
 *
 * 内置默认的代价（必须让用户知道）：
 *   - Active Sessions 里这条授权显示成 "Telegram Desktop"（App 名由 api_id 决定，改不了）；
 *   - 该 api_id 被大量第三方客户端共用，可能被 `API_ID_PUBLISHED_FLOOD` 拒绝；
 *   - 拿自己的 api_id 后重登一次即可，插件其余部分不受影响。
 * 设备名（deviceModel）是**我们**在 initConnection 里传的，与 api_id 无关，
 * 所以条目仍会显示 "Coopanion Telegram World"，可与真 Desktop 区分。
 */

export type CredentialSource = 'config' | 'env' | 'builtin';

export interface Credentials {
  apiId: number;
  apiHash: string;
  source: CredentialSource;
  /** 给人看的来源说明。 */
  label: string;
}

/** Telegram Desktop 的公开凭据。登不上时先怀疑它被限流，而不是代码。 */
export const BUILTIN: Credentials = {
  apiId: 2040,
  apiHash: 'b18441a1ff607e10a989891a5462e627',
  source: 'builtin',
  label: 'Telegram 电脑版公开凭据（无需注册，但可能被限流）',
};

export interface CredentialInput {
  /** 配置里的值；0/空 = 未设置。 */
  apiId?: number | string;
  apiHash?: string;
  /** 读环境变量（默认 process.env）。 */
  env?: (name: string) => string | undefined;
}

export type ResolveResult =
  | { ok: true; value: Credentials }
  | { ok: false; error: string; detail?: string };

function parseId(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function looksLikeHash(v: string): boolean {
  return /^[0-9a-f]{32}$/i.test(v.trim());
}

/** 面板/日志用：只露头尾。 */
export function maskHash(hash: string): string {
  const h = hash.trim();
  if (h.length < 10) return '*'.repeat(h.length);
  return `${h.slice(0, 4)}…${h.slice(-4)}`;
}

export function resolveCredentials(input: CredentialInput = {}): ResolveResult {
  const env = input.env ?? ((name: string) => process.env[name]);

  const cfgId = parseId(input.apiId);
  const cfgHash = (input.apiHash ?? '').trim();
  if (cfgId || cfgHash) {
    if (!cfgId && cfgHash) {
      return { ok: false, error: '填了 api_hash 但没填 api_id（两者必须成对）', detail: '两者必须成对出现' };
    }
    if (cfgId && !cfgHash) {
      return { ok: false, error: '填了 api_id 但没填 api_hash（两者必须成对）', detail: '两者必须成对出现' };
    }
    if (!looksLikeHash(cfgHash)) {
      return { ok: false, error: 'api_hash 格式不对（应为 32 位十六进制）', detail: '应为 32 位十六进制，例如 b18441a1ff607e10a989891a5462e627' };
    }
    return {
      ok: true,
      value: { apiId: cfgId, apiHash: cfgHash, source: 'config', label: '面板/配置填写' },
    };
  }

  const envId = parseId(env('TG_API_ID'));
  const envHash = (env('TG_API_HASH') ?? '').trim();
  if (envId && envHash) {
    if (!looksLikeHash(envHash)) {
      return { ok: false, error: '.env 里的 TG_API_HASH 格式不对', detail: '应为 32 位十六进制' };
    }
    return {
      ok: true,
      value: { apiId: envId, apiHash: envHash, source: 'env', label: '部署 .env（TG_API_ID / TG_API_HASH）' },
    };
  }
  if (envId || envHash) {
    return {
      ok: false,
      error: '.env 里 TG_API_ID / TG_API_HASH 只配了一个（必须成对）',
      detail: '两者必须成对出现；也可以两个都删掉，改用面板填写',
    };
  }

  return { ok: true, value: BUILTIN };
}

/** 面板展示（不含 hash 明文）。 */
export function describeCredentials(c: Credentials): {
  apiId: number;
  apiHashMasked: string;
  source: CredentialSource;
  label: string;
} {
  return { apiId: c.apiId, apiHashMasked: maskHash(c.apiHash), source: c.source, label: c.label };
}

/** 日志指纹：同一个凭据在日志里始终是同一个短串，但无法反推。 */
export function credentialFingerprint(c: Credentials): string {
  let h = 0;
  const src = `${c.apiId}:${c.apiHash}`;
  for (let i = 0; i < src.length; i += 1) h = (h * 31 + src.charCodeAt(i)) | 0;
  return `cred-${(h >>> 0).toString(36)}`;
}
