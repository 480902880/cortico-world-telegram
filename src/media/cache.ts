/**
 * 媒体缓存清理。
 *
 * 下载的图片/语音/视频会一直堆在 `data/telegram/media/`，几周就是几百 MB。
 * 这里按 `mediaKeepHours` 删旧的——只删我们自己下载/转码的产物，不碰用户配置的素材目录。
 */

import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 删单个文件并**确认真的删掉了**。
 *
 * 实测（Windows）：`rmSync(p, { force: true })` 会静默失败——不抛错、文件还在。
 * 所以走 unlink，并且用 existsSync 复核；统计"删了几个"必须以此为准。
 */
function removeFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    unlinkSync(path);
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      // 被占用：留到下次
    }
  }
  return !existsSync(path);
}

export interface CacheFile {
  path: string;
  size: number;
  mtime: number;
}

/** 纯函数：挑出该删的文件（超过保留时长）。方便单测。 */
export function selectExpired(files: readonly CacheFile[], keepMs: number, now = Date.now()): CacheFile[] {
  if (!Number.isFinite(keepMs) || keepMs <= 0) return [];
  return files.filter((file) => now - file.mtime > keepMs);
}

/** 人类可读体积。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`;
}

/** 递归列出某个目录下的文件（一层层走，跳过子目录深挖限制）。 */
export function listFiles(root: string, maxDepth = 3): CacheFile[] {
  if (!root || !existsSync(root)) return [];
  const out: CacheFile[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        try {
          const stat = statSync(full);
          out.push({ path: full, size: stat.size, mtime: stat.mtimeMs });
        } catch {
          // 单个文件读不到就跳过
        }
      } else if (entry.isDirectory() && depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

export interface PruneResult {
  removed: number;
  bytes: number;
  kept: number;
}

/** 目录当前规模：多少文件、占多少字节。 */
export function cacheStats(root: string): { files: number; bytes: number } {
  const files = listFiles(root);
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}

/** 清空整个目录（bot 手动"全清"用）。返回删了多少、释放多少。 */
export function clearMediaDir(root: string): PruneResult {
  const files = listFiles(root);
  let removed = 0;
  let bytes = 0;
  for (const file of files) {
    if (removeFile(file.path)) {
      removed += 1;
      bytes += file.size;
    }
  }
  return { removed, bytes, kept: files.length - removed };
}

/**
 * 删掉超过保留时长的文件。`keepHours <= 0` 时什么都不做（= 永久保留）。
 * 删除失败（文件被占用）不报错，只跳过——清理是维护动作，不该打断消息处理。
 */
export function pruneMediaDir(root: string, keepHours: number, now = Date.now()): PruneResult {
  const keepMs = keepHours * 3600_000;
  const files = listFiles(root);
  if (!Number.isFinite(keepMs) || keepMs <= 0) return { removed: 0, bytes: 0, kept: files.length };

  const expired = selectExpired(files, keepMs, now);
  let removed = 0;
  let bytes = 0;
  for (const file of expired) {
    if (removeFile(file.path)) {
      removed += 1;
      bytes += file.size;
    }
  }
  return { removed, bytes, kept: files.length - removed };
}
