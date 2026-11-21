/**
 * 代理自动解析与动态传输层。
 *
 * 目标：用户在 Clash / v2rayN 等代理软件里只开「系统代理」（不开 TUN / 虚拟网卡），
 * 扩展就能自动识别并通过 HTTP CONNECT / SOCKS 隧道直连 Telegram DC；
 * 中途开关系统代理或换端口时，重连会自动感知，无需重启。
 *
 * 优先级：
 *   1. 配置显式指定的 `transport.proxy`（支持 http/https/socks4/socks5/mtproxy/direct）
 *   2. 环境变量 `ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`（尊重 `NO_PROXY=*`）
 *   3. 操作系统系统代理（Windows 注册表 Internet Settings + 本地 PAC；macOS `scutil --proxy`）
 *   4. 直连 TCP（无代理或已开 TUN）
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProxySpec =
  | { kind: 'direct' }
  | { kind: 'http' | 'https'; host: string; port: number; username?: string; password?: string }
  | { kind: 'socks4' | 'socks5'; host: string; port: number; username?: string; password?: string }
  | { kind: 'mtproxy'; host: string; port: number; secret: string };

export type ActiveProxySpec = Exclude<ProxySpec, { kind: 'direct' }>;

export interface ResolvedProxy {
  spec: ActiveProxySpec;
  source: 'config' | 'env' | 'system' | 'pac';
}

export interface ProxyLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface NetworkExports {
  NetSocket: any;
  HttpProxyTransport: any;
  SocksTransport: any;
  MTProxyTransport: any;
  ConnectionTCPObfuscated: any;
}

const DEFAULT_PORT: Record<'http' | 'https' | 'socks4' | 'socks5', number> = {
  http: 80,
  https: 443,
  socks4: 1080,
  socks5: 1080,
};

const SYSTEM_PROXY_CACHE_TTL_MS = 2000;
const REG_QUERY_TIMEOUT_MS = 2000;
const PAC_FETCH_TIMEOUT_MS = 1500;
const PAC_MAX_BYTES = 256 * 1024;
const TUNNEL_TIMEOUT_SECONDS = 10;

function validPort(raw: string | number | undefined, fallback?: number): number {
  const port = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new Error(`无效代理端口：${String(raw ?? '')}`);
  }
  return port as number;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function bracketHost(host: string): string {
  const h = host.trim();
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 从 URL 的 `scheme://` 之后提取显式写的端口号。
 * WHATWG `new URL('http://host:80')` 会把 `:80` 规范化为空串，直接用 `u.port` 会丢掉 80 端口。
 */
function extractExplicitPort(afterScheme: string): string | undefined {
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  const atIdx = authority.lastIndexOf('@');
  const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
  const ipv6 = /^\[[^\]]+\]:(\d+)$/.exec(hostPort);
  if (ipv6) return ipv6[1];
  const plain = /^[^:]+:(\d+)$/.exec(hostPort);
  if (plain) return plain[1];
  return undefined;
}

/**
 * 解析单条代理地址。
 * 支持：
 *   - 空串 → null（走自动探测）
 *   - direct / none / off → 显式直连
 *   - http:// / https:// / socks5:// / socks5h:// / socks:// / socks4:// / socks4a://
 *   - mtproxy://secret@host:port / tg://proxy?server=...&port=...&secret=... / https://t.me/proxy?...
 *   - 裸 host:port（如 Windows 注册表里的 `127.0.0.1:7897`，按 HTTP 代理处理）
 */
export function parseProxyUrl(raw: string | undefined): ProxySpec | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  const lower = s.toLowerCase();
  if (lower === 'direct' || lower === 'none' || lower === 'off') {
    return { kind: 'direct' };
  }

  // tg://proxy?server=...&port=...&secret=... 或 https://t.me/proxy?...
  if (/^(?:tg:\/\/proxy\?|https?:\/\/t\.me\/proxy\?)/i.test(s)) {
    const u = new URL(s.replace(/^tg:\/\//i, 'https://t.me/'));
    const host = (u.searchParams.get('server') ?? '').trim();
    const secret = (u.searchParams.get('secret') ?? '').trim();
    const port = validPort(u.searchParams.get('port') ?? undefined);
    if (!host || !secret) throw new Error(`MTProxy 链接缺少 server 或 secret：${s}`);
    return { kind: 'mtproxy', host: stripBrackets(host), port, secret };
  }

  // mtproxy://secret@host:port
  if (/^mtproxy:\/\//i.test(s)) {
    const rest = s.slice('mtproxy://'.length);
    const u = new URL(`http://${rest}`);
    const host = stripBrackets(u.hostname);
    // searchParams.get 已解码过，只对 username 做安全解码，避免二次解码
    const secret = u.username ? safeDecode(u.username) : (u.searchParams.get('secret') ?? '').trim();
    const port = validPort(extractExplicitPort(rest) ?? (u.port || undefined));
    if (!host || !secret) throw new Error(`MTProxy 地址缺少主机或 secret：${s}`);
    return { kind: 'mtproxy', host, port, secret };
  }

  // 带协议头的标准代理 URL
  const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(s);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    let kind: 'http' | 'https' | 'socks4' | 'socks5';
    if (scheme === 'http') kind = 'http';
    else if (scheme === 'https') kind = 'https';
    else if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks') kind = 'socks5';
    else if (scheme === 'socks4' || scheme === 'socks4a') kind = 'socks4';
    else throw new Error(`代理协议暂不支持：${scheme}（支持 http / https / socks5 / socks4 / mtproxy）`);

    const rest = s.slice(schemeMatch[0].length);
    const u = new URL(`http://${rest}`);
    const host = stripBrackets(u.hostname);
    if (!host) throw new Error(`代理地址缺少主机名：${s}`);
    const explicitPort = extractExplicitPort(rest);
    const port = validPort(explicitPort ?? (u.port || undefined), DEFAULT_PORT[kind]);
    const spec: Extract<ActiveProxySpec, { kind: 'http' | 'https' | 'socks4' | 'socks5' }> = { kind, host, port };
    if (u.username) spec.username = safeDecode(u.username);
    if (u.password) spec.password = safeDecode(u.password);
    return spec;
  }

  // 裸 host:port 或 [ipv6]:port（常见于 Windows ProxyServer，例如 127.0.0.1:7897 / 127.0.0.1:80）
  if (/^(?:\[[^\]]+\]|[^/\s:]+):\d+$/.test(s)) {
    const u = new URL(`http://${s}`);
    const host = stripBrackets(u.hostname);
    const port = validPort(extractExplicitPort(s) ?? (u.port || undefined));
    if (host) return { kind: 'http', host, port };
  }

  throw new Error(`无法解析代理地址：${s}（示例：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）`);
}

/** 从环境变量读取代理（ALL_PROXY > HTTPS_PROXY > HTTP_PROXY；NO_PROXY 含 `*` 时跳过）。 */
export function detectEnvProxy(env: Record<string, string | undefined> = process.env): ResolvedProxy | null {
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '').trim();
  if (noProxy && noProxy.split(',').some((item) => item.trim() === '*')) return null;

  const candidates = [
    env.ALL_PROXY,
    env.all_proxy,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ];
  for (const raw of candidates) {
    if (!raw?.trim()) continue;
    try {
      const parsed = parseProxyUrl(raw);
      if (parsed && parsed.kind !== 'direct') {
        return { spec: parsed, source: 'env' };
      }
    } catch {
      // 环境变量格式异常时忽略，继续尝试下一条
    }
  }
  return null;
}

/**
 * 解析 Windows `ProxyServer` 字符串。
 * 两种常见形态：
 *   1) 单值：`127.0.0.1:7897`、`http://127.0.0.1:7897`、`socks5://127.0.0.1:1080`
 *   2) 分协议：`http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808`
 *
 * 注意：Windows 的 `https=host:port` 表示「给 HTTPS 流量用的 HTTP 代理」，
 * 代理本身走明文 HTTP CONNECT（不是 TLS-to-proxy），因此必须按 `http` 解析。
 */
export function parseWindowsProxyServer(raw: string): ActiveProxySpec | null {
  const s = raw.trim();
  if (!s) return null;

  // 带协议头的单值 URL（例如 http://user:a=b@127.0.0.1:7890）不能按分协议 k=v 拆分
  if (!/^[a-z0-9+.-]+:\/\//i.test(s) && s.includes('=')) {
    const entries = new Map<string, string>();
    for (const part of s.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const key = part.slice(0, idx).trim().toLowerCase();
      const val = part.slice(idx + 1).trim();
      if (key && val) entries.set(key, val);
    }

    // 优先 socks（v2rayN 等分端口客户端常同时写 http= 和 socks=），其次 https / http
    const ordered: Array<[string, 'socks5' | 'http']> = [
      ['socks5', 'socks5'],
      ['socks', 'socks5'],
      ['https', 'http'],
      ['http', 'http'],
    ];
    for (const [key, defaultScheme] of ordered) {
      const val = entries.get(key);
      if (!val) continue;
      try {
        const normalized = /^[a-z0-9+.-]+:\/\//i.test(val) ? val : `${defaultScheme}://${val}`;
        const parsed = parseProxyUrl(normalized);
        if (parsed && parsed.kind !== 'direct') return parsed;
      } catch {
        // 尝试下一个协议项
      }
    }
    return null;
  }

  try {
    const parsed = parseProxyUrl(s);
    return parsed && parsed.kind !== 'direct' ? parsed : null;
  } catch {
    return null;
  }
}

/** 解析 `reg query "HKCU\...\Internet Settings"` 的 stdout。 */
export function parseWindowsInternetSettings(output: string): {
  proxy: ActiveProxySpec | null;
  autoConfigUrl: string | null;
} {
  let proxyEnable = false;
  let proxyServer = '';
  let autoConfigUrl = '';

  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(ProxyEnable|ProxyServer|AutoConfigURL)\s+REG_\w+\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    const val = match[2]!.trim();
    if (name === 'proxyenable') {
      proxyEnable = Number.parseInt(val, 0) === 1;
    } else if (name === 'proxyserver') {
      proxyServer = val;
    } else if (name === 'autoconfigurl') {
      autoConfigUrl = val;
    }
  }

  if (proxyEnable && proxyServer) {
    const proxy = parseWindowsProxyServer(proxyServer);
    if (proxy) return { proxy, autoConfigUrl: null };
  }

  // 只接受本机 PAC 地址（Clash / v2rayN 的 PAC 模式），绝不拉远端脚本
  const localPac = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(autoConfigUrl)
    ? autoConfigUrl
    : null;
  return { proxy: null, autoConfigUrl: localPac };
}

/** 从 PAC 脚本文本里安全提取代理节点（先去注释，不执行 JS；优先字符串字面量中靠前的指令）。 */
export function parsePacScript(body: string): ActiveProxySpec | null {
  // 去掉块注释和行注释（不误伤字符串里的 http://，只删空白或行首后的 //）
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[\s;{}()])\/\/[^\r\n]*/g, '$1');

  const re = /\b(SOCKS5|SOCKS|HTTPS|PROXY)\s+((?:\[[^\]]+\]|[^\s;'"`)+]+):\d+)/gi;
  let match: RegExpExecArray | null;
  let fallback: ActiveProxySpec | null = null;
  while ((match = re.exec(stripped)) !== null) {
    const directive = match[1]!.toUpperCase();
    const target = match[2]!;
    const scheme = directive === 'SOCKS5' || directive === 'SOCKS'
      ? 'socks5'
      : directive === 'HTTPS'
        ? 'https'
        : 'http';
    try {
      const parsed = parseProxyUrl(`${scheme}://${target}`);
      if (parsed && parsed.kind !== 'direct') {
        if (directive === 'SOCKS5') return parsed;
        if (!fallback) fallback = parsed;
      }
    } catch {
      // 继续尝试下一个匹配
    }
  }
  return fallback;
}

/** 解析 macOS `scutil --proxy` 输出。 */
export function parseMacScutilProxy(output: string): ActiveProxySpec | null {
  const kv = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) kv.set(m[1]!, m[2]!);
  }
  const tryBuild = (scheme: 'socks5' | 'http', hostKey: string, portKey: string): ActiveProxySpec | null => {
    const host = kv.get(hostKey);
    const port = kv.get(portKey);
    if (!host || !port) return null;
    try {
      const parsed = parseProxyUrl(`${scheme}://${bracketHost(host)}:${port}`);
      return parsed && parsed.kind !== 'direct' ? parsed : null;
    } catch {
      return null;
    }
  };

  if (kv.get('SOCKSEnable') === '1') {
    const r = tryBuild('socks5', 'SOCKSProxy', 'SOCKSPort');
    if (r) return r;
  }
  if (kv.get('HTTPSEnable') === '1') {
    const r = tryBuild('http', 'HTTPSProxy', 'HTTPSPort');
    if (r) return r;
  }
  if (kv.get('HTTPEnable') === '1') {
    const r = tryBuild('http', 'HTTPProxy', 'HTTPPort');
    if (r) return r;
  }
  return null;
}

let cachedSystem: { at: number; value: ResolvedProxy | null } | null = null;
let inFlightSystem: Promise<ResolvedProxy | null> | null = null;

/** 清空系统代理短缓存（主动建连前或测试时调用）。 */
export function clearSystemProxyCache(): void {
  cachedSystem = null;
}

async function querySystemProxyUncached(): Promise<ResolvedProxy | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { timeout: REG_QUERY_TIMEOUT_MS, windowsHide: true },
      );
      const parsed = parseWindowsInternetSettings(stdout);
      if (parsed.proxy) {
        return { spec: parsed.proxy, source: 'system' };
      }
      if (parsed.autoConfigUrl) {
        try {
          const res = await fetch(parsed.autoConfigUrl, {
            signal: AbortSignal.timeout(PAC_FETCH_TIMEOUT_MS),
          });
          if (res.ok) {
            const len = Number(res.headers.get('content-length') ?? 0);
            if (!len || len <= PAC_MAX_BYTES) {
              const text = (await res.text()).slice(0, PAC_MAX_BYTES);
              const pacProxy = parsePacScript(text);
              if (pacProxy) return { spec: pacProxy, source: 'pac' };
            }
          }
        } catch {
          // 本地 PAC 拉取失败时静默降级
        }
      }
    } else if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('scutil', ['--proxy'], { timeout: REG_QUERY_TIMEOUT_MS });
      const parsed = parseMacScutilProxy(stdout);
      if (parsed) return { spec: parsed, source: 'system' };
    }
  } catch {
    // 查不到系统代理时不阻断直连
  }
  return null;
}

/** 读取当前操作系统的系统代理（带 2 秒短缓存 + 并发去重，避免多 socket 同时起多个子进程）。 */
export async function detectSystemProxy(): Promise<ResolvedProxy | null> {
  const now = Date.now();
  if (cachedSystem && now - cachedSystem.at < SYSTEM_PROXY_CACHE_TTL_MS) {
    return cachedSystem.value;
  }
  if (inFlightSystem) return inFlightSystem;

  inFlightSystem = querySystemProxyUncached()
    .then((value) => {
      cachedSystem = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlightSystem = null;
    });
  return inFlightSystem;
}

export interface ResolveProxyDeps {
  env?: Record<string, string | undefined>;
  detectSystem?: () => Promise<ResolvedProxy | null>;
}

/** 综合配置、环境变量与系统代理，得出本次连接应使用的代理。 */
export async function resolveEffectiveProxy(
  explicitRaw: string | undefined,
  deps: ResolveProxyDeps = {},
): Promise<ResolvedProxy | null> {
  const explicit = parseProxyUrl(explicitRaw);
  if (explicit) {
    return explicit.kind === 'direct' ? null : { spec: explicit, source: 'config' };
  }

  const envProxy = detectEnvProxy(deps.env ?? process.env);
  if (envProxy) return envProxy;

  return (deps.detectSystem ?? detectSystemProxy)();
}

/** 日志展示用的脱敏字符串（绝不输出代理密码或 MTProxy secret）。 */
export function formatProxyForLog(resolved: ResolvedProxy | null): string {
  if (!resolved) return 'direct';
  const { spec, source } = resolved;
  const host = spec.host.includes(':') ? `[${spec.host}]` : spec.host;
  return `${spec.kind}://${host}:${spec.port} (${source})`;
}

function isAutoProxyFallbackable(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const code = error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? '') : '';
  const msg = error instanceof Error ? error.message : String(error);
  return (
    name === 'ProxyRejectedError'
    || /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ProxyRejected|refused CONNECT|rejected the credentials/i.test(`${code} ${msg}`)
  );
}

export interface AutoProxyTransportOptions {
  explicitProxy?: string;
  initialProxied?: boolean;
  resolveProxy?: () => Promise<ResolvedProxy | null>;
  log?: ProxyLogger;
}

/**
 * 构造给 `teleproto` 的 Transport：
 *   - 显式配置 `mtproxy://` → 直接使用 `MTProxyTransport`（独立封包协议）。
 *   - 其余情况 → 动态代理 Transport：每次建连 / 断线重连时重新解析当前代理，
 *     支持 HTTP / HTTPS / SOCKS4 / SOCKS5 与直连无缝切换。
 */
export function buildAutoProxyTransport(net: NetworkExports, opts: AutoProxyTransportOptions = {}): any {
  const explicit = parseProxyUrl(opts.explicitProxy);
  if (explicit?.kind === 'mtproxy') {
    opts.log?.info('MTProto 连接通道', { route: formatProxyForLog({ spec: explicit, source: 'config' }) });
    return new net.MTProxyTransport({
      host: explicit.host,
      port: explicit.port,
      secret: explicit.secret,
    });
  }

  const resolveProxy = opts.resolveProxy ?? (() => resolveEffectiveProxy(opts.explicitProxy));
  let lastRoute = '';

  const openViaSpec = (spec: ActiveProxySpec, port: number, ip: string): Promise<any> => {
    if (spec.kind === 'http' || spec.kind === 'https') {
      const route = new net.HttpProxyTransport({
        host: spec.host,
        port: spec.port,
        tls: spec.kind === 'https',
        username: spec.username,
        password: spec.password,
        timeout: TUNNEL_TIMEOUT_SECONDS,
      }).resolve();
      return new route.socket().openTunnel(port, ip);
    }
    if (spec.kind === 'socks4' || spec.kind === 'socks5') {
      const route = new net.SocksTransport({
        host: spec.host,
        port: spec.port,
        version: spec.kind === 'socks4' ? 4 : 5,
        username: spec.username,
        password: spec.password,
        timeout: TUNNEL_TIMEOUT_SECONDS,
      }).resolve();
      return new route.socket().openTunnel(port, ip);
    }
    throw new Error(`动态通道不支持该代理类型：${spec.kind}`);
  };

  return {
    resolve(connection?: any) {
      class DynamicProxySocket extends net.NetSocket {
        async openTunnel(port: number, ip: string): Promise<any> {
          const resolved = await resolveProxy();
          const label = formatProxyForLog(resolved);
          if (label !== lastRoute) {
            lastRoute = label;
            opts.log?.info('MTProto 连接通道', { route: label });
          }
          if (!resolved) return undefined;

          try {
            return await openViaSpec(resolved.spec, port, ip);
          } catch (error) {
            // 自动探测到的代理不可达或拒绝 CONNECT（避免 ProxyRejectedError 杀掉 teleproto 自动重连循环）时，
            // 退回直连；显式配置的代理绝不静默绕过。
            if (resolved.source !== 'config' && isAutoProxyFallbackable(error)) {
              const reason = error instanceof Error ? error.message : String(error);
              opts.log?.warn('自动检测到的代理不可用，尝试直连', { route: label, reason });
              return undefined;
            }
            throw error;
          }
        }
      }

      return {
        connection: connection ?? net.ConnectionTCPObfuscated,
        socket: DynamicProxySocket,
        // 未显式指定直连时，始终倾向 Telegram 静态 DC IP（直连与代理都兼容，避免代理切换时撞上地区动态 IP）
        proxied: explicit?.kind !== 'direct',
      };
    },
  };
}
