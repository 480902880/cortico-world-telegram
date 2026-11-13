/**
 * 本地资源目录与登记。
 *
 * 解决的问题（规划 §6）：TTS / 绘图 / 视频工具在本地生成文件，Agent 不该去猜路径，
 * 也不该被允许翻整块硬盘。所以：
 *
 *  1. 用户在面板/配置里指定 7 个目录（语音/图片/视频/文件/贴纸/下载/临时）；
 *  2. 所有本地文件访问都必须落在这些根目录内——按 **realpath** 比较，符号链接、`..` 都逃不出去；
 *  3. 提供「最近生成的文件」扫描与登记索引，Agent 用 `telegram_find_local_media` 拿路径，
 *     再用 `telegram_send_media` 发出去。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';

export type ResourceKind = 'voice' | 'song' | 'image' | 'video' | 'file' | 'sticker' | 'download';

export const RESOURCE_KINDS: readonly ResourceKind[] = ['voice', 'song', 'image', 'video', 'file', 'sticker', 'download'];

export type ResourceDirs = Record<ResourceKind, string>;

export const KIND_LABEL: Record<ResourceKind, string> = {
  voice: '语音生成目录',
  song: '唱歌目录',
  image: '图片素材目录',
  video: '视频素材目录',
  file: '普通文件目录',
  sticker: '表情包目录',
  download: 'Telegram 下载目录',
};

/** 每个目录是干什么的——面板上直接显示，别让人猜。 */
export const KIND_HINT: Record<ResourceKind, string> = {
  voice: 'TTS / 语音合成的输出，例：gpt-sovits 的保存目录',
  song: 'RVC 翻唱 / 翻调的输出（wav / mp3 / flac / m4a）',
  image: 'AI 绘图等图片产物（png / jpg / webp）',
  video: '本地视频生成的结果（mp4 / mov）',
  file: 'PDF、压缩包、文档这类普通文件',
  sticker: '本地表情素材：png/webp/tgs/webm 当表情发，gif 当动图，jpg 当图片',
  download: 'Telegram 收到的图片、语音、文件落在这里',
};

const EXT_KIND: Record<string, ResourceKind> = {
  '.ogg': 'voice', '.opus': 'voice', '.wav': 'voice', '.mp3': 'voice', '.m4a': 'voice', '.flac': 'voice', '.aac': 'voice',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.bmp': 'image', '.gif': 'image',
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.webm': 'video', '.avi': 'video',
  '.tgs': 'sticker', '.twebp': 'sticker',
  '.pdf': 'file', '.zip': 'file', '.7z': 'file', '.rar': 'file', '.txt': 'file', '.md': 'file', '.docx': 'file', '.xlsx': 'file',
};

export function kindOfFile(path: string): ResourceKind {
  return EXT_KIND[extname(path).toLowerCase()] ?? 'file';
}

/** 能当 Telegram **贴纸**发送的格式（512px、≤512KB 才行）。 */
export const STICKER_EXTS = ['.png', '.webp', '.tgs', '.webm'] as const;

export function isStickerFile(path: string): boolean {
  return (STICKER_EXTS as readonly string[]).includes(extname(path).toLowerCase());
}

/**
 * 本地素材实际会以什么形态发出：
 *  - `sticker`：png/webp/tgs/webm —— 带 sticker 属性，显示为表情
 *  - `gif`：gif —— 当动图文档发，显示为 GIF
 *  - `photo`：jpg/jpeg —— 当普通照片发（jpg 不能当贴纸，Telegram 会拒）
 *  - `null`：其他格式，用不了
 */
export type LocalStickerForm = 'sticker' | 'gif' | 'photo';

export function localStickerForm(path: string): LocalStickerForm | null {
  const ext = extname(path).toLowerCase();
  if ((STICKER_EXTS as readonly string[]).includes(ext)) return 'sticker';
  if (ext === '.gif') return 'gif';
  if (ext === '.jpg' || ext === '.jpeg') return 'photo';
  return null;
}

/** 能不能拿来发（三种形态之一）。 */
export function isLocalStickerUsable(path: string): boolean {
  return localStickerForm(path) !== null;
}

/** 本地表情文件 → Telegram 能认的 MIME。 */
export function stickerMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.webp': return 'image/webp';
    case '.tgs': return 'application/x-tgsticker';
    case '.webm': return 'video/webm';
    default: return 'image/png';
  }
}

export interface ResourceFile {
  path: string;
  name: string;
  kind: ResourceKind;
  size: number;
  mtime: number;
}

/** 目录存在性/可写/规模——面板与模板变量都要用。 */
export interface DirStatus {
  kind: ResourceKind;
  path: string;
  configured: boolean;
  exists: boolean;
  writable: boolean;
  files: number;
  newest?: ResourceFile;
}

function realOf(path: string): string {
  let real: string;
  try {
    // native 版本会展开 8.3 短名与符号链接；Windows 下大小写不敏感
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function isInside(target: string, root: string): boolean {
  const t = realOf(target);
  const r = realOf(root);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** 无论在哪都不许外发的文件名（等于账号控制权，或凭据）。 */
const DENY_BASENAMES = new Set([
  '.env', '.env.local', '.env.production',
  'session.txt', 'state.json', 'instance.lock', 'resources.json', 'sticker-tags.json',
  'id_rsa', 'id_ed25519', 'credentials.json', 'config.json', '.npmrc', '.netrc',
]);

/** 密钥类扩展名。 */
const DENY_EXTS = new Set(['.pem', '.key', '.pfx', '.p12', '.kdbx', '.ppk', '.keystore']);

export interface SendPathPolicy {
  /** 允许的根目录；null 表示不限路径（仅主人，M2 才接）。 */
  roots: readonly string[] | null;
  /** 无论在不在 roots 内都禁止的目录（如 data/telegram）。 */
  denyDirs: readonly string[];
  /** denyDirs 内仍然放行的子目录（如 data/telegram/media）。 */
  allowUnder?: readonly string[];
}

/**
 * 发送专用路径校验。
 *
 * 与 `resolveWithinRoots`（登记/本地表情用）分开：这里额外做**黑名单**和目录级封禁，
 * 因为 `session.txt` 就在数据目录里，一旦被发出去等于把账号交出去。
 *
 * 返回的 `path` 是 realpath —— 后续发送用它，避免校验后被人换成符号链接。
 */
export function resolveForSend(
  raw: string,
  policy: SendPathPolicy,
): { ok: true; path: string } | { ok: false; error: string } {
  const value = (raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!value) return { ok: false, error: '路径为空' };

  let candidate: string;
  if (policy.roots === null) {
    candidate = resolve(value);
  } else {
    const usable = policy.roots.filter((root) => !!root);
    if (!usable.length) return { ok: false, error: '还没有配置任何本地资源目录（设置 → 媒体目录）' };
    const absolute = resolve(value);
    if (!usable.some((root) => isInside(absolute, root))) {
      return { ok: false, error: '该路径不在授权的资源目录内' };
    }
    candidate = absolute;
  }

  let real: string;
  try {
    real = realpathSync.native(candidate);
  } catch {
    return { ok: false, error: '文件不存在' };
  }

  const name = basename(real).toLowerCase();
  if (DENY_BASENAMES.has(name) || DENY_EXTS.has(extname(name))) {
    return { ok: false, error: '该文件禁止发送' };
  }
  for (const dir of policy.denyDirs) {
    if (!dir) continue;
    if (isInside(real, dir) && !(policy.allowUnder ?? []).some((allow) => allow && isInside(real, allow))) {
      return { ok: false, error: '该目录下的文件禁止发送' };
    }
  }
  return { ok: true, path: real };
}

/**
 * 把用户/Agent 给的路径限定在授权根目录内。
 *
 * 用 realpath 比较，因此：`../` 穿越、指向外面的符号链接、大小写差异都会在规范化后被挡住。
 */
export function resolveWithinRoots(
  raw: string,
  roots: readonly string[],
): { ok: true; path: string } | { ok: false; error: string } {
  const value = (raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!value) return { ok: false, error: '路径为空' };
  const usable = roots.filter((root) => !!root);
  if (!usable.length) {
    return { ok: false, error: '还没有配置任何本地资源目录（设置 → 媒体目录）' };
  }
  const absolute = resolve(value);
  if (!usable.some((root) => isInside(absolute, root))) {
    // 不回显根目录列表：错误信息会进模型上下文，可能被转述到聊天里
    return { ok: false, error: '该路径不在授权的资源目录内' };
  }
  return { ok: true, path: absolute };
}

/** 目录状态（一次 stat + 一次 readdir）。 */
export function inspectDir(kind: ResourceKind, path: string): DirStatus {
  const configured = !!path;
  if (!configured) return { kind, path: '', configured: false, exists: false, writable: false, files: 0 };
  if (!existsSync(path)) return { kind, path, configured, exists: false, writable: false, files: 0 };
  let files = 0;
  let newest: ResourceFile | undefined;
  let writable = true;
  try {
    readdirSync(path);
  } catch {
    writable = false;
  }
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = join(path, entry.name);
      try {
        const st = statSync(full);
        files += 1;
        if (!newest || st.mtimeMs > newest.mtime) {
          newest = { path: full, name: entry.name, kind: kindOfFile(full), size: st.size, mtime: st.mtimeMs };
        }
      } catch {
        // 单个文件读不到就算了
      }
    }
  } catch {
    // 目录不可读
  }
  return { kind, path, configured, exists: true, writable, files, ...(newest ? { newest } : {}) };
}

export function inspectAll(dirs: ResourceDirs): DirStatus[] {
  return RESOURCE_KINDS.map((kind) => inspectDir(kind, dirs[kind]));
}

/** 目录下最近改动的文件（只看一层，不递归——避免扫爆大盘）。 */
export function scanRecent(dir: string, limit = 30): ResourceFile[] {
  if (!dir || !existsSync(dir)) return [];
  const out: ResourceFile[] = [];
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(dir, entry.name);
    try {
      const st = statSync(full);
      out.push({ path: full, name: entry.name, kind: kindOfFile(full), size: st.size, mtime: st.mtimeMs });
    } catch {
      // 忽略
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, Math.max(1, limit));
}

// ---------------------------------------------------------------------------
// 登记索引
// ---------------------------------------------------------------------------

export interface RegisteredMedia {
  path: string;
  name: string;
  kind: ResourceKind;
  size: number;
  mtime: number;
  source: string;
  note?: string;
  registeredAt: number;
}

interface IndexFile {
  version: 1;
  items: RegisteredMedia[];
}

const INDEX_MAX = 300;

/**
 * 登记索引：别的 World（TTS/绘图）把产物登记进来，Telegram 侧直接取用。
 * 落盘在 `data/telegram/resources.json`，最多保留 300 条。
 */
export class ResourceIndex {
  private items: RegisteredMedia[] = [];
  private loaded = false;

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<IndexFile>;
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      this.items = items
        .filter((item): item is RegisteredMedia => !!item && typeof item.path === 'string')
        .slice(-INDEX_MAX);
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf8');
    } catch {
      // 落盘失败不影响内存索引
    }
  }

  /** 登记（同一路径会覆盖旧记录）。 */
  register(entry: Omit<RegisteredMedia, 'registeredAt'> & { registeredAt?: number }): RegisteredMedia {
    this.load();
    const record: RegisteredMedia = { ...entry, registeredAt: entry.registeredAt ?? Date.now() };
    this.items = this.items.filter((item) => item.path !== record.path);
    this.items.push(record);
    if (this.items.length > INDEX_MAX) this.items = this.items.slice(-INDEX_MAX);
    this.save();
    return record;
  }

  list(opts: { kind?: ResourceKind; limit?: number; query?: string } = {}): RegisteredMedia[] {
    this.load();
    const needle = (opts.query ?? '').toLowerCase();
    let out = [...this.items];
    if (opts.kind) out = out.filter((item) => item.kind === opts.kind);
    if (needle) {
      out = out.filter((item) => item.name.toLowerCase().includes(needle) || (item.source ?? '').toLowerCase().includes(needle));
    }
    out.sort((a, b) => b.registeredAt - a.registeredAt);
    return out.slice(0, Math.max(1, opts.limit ?? 20));
  }

  size(): number {
    this.load();
    return this.items.length;
  }
}

/** 给模板变量/回执用：`name (12 KB, 3 分钟前)`。 */
export function describeResource(file: ResourceFile, now = Date.now()): string {
  const kb = file.size >= 1024 ? `${(file.size / 1024).toFixed(0)} KB` : `${file.size} B`;
  const ageMin = Math.max(0, Math.round((now - file.mtime) / 60000));
  const age = ageMin < 1 ? '刚刚' : ageMin < 60 ? `${ageMin} 分钟前` : `${Math.round(ageMin / 60)} 小时前`;
  return `${basename(file.name)} (${kb}, ${age})`;
}
