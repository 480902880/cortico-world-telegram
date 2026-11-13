/**
 * 把 Agent 给的「文件」解析成本机真实路径。
 *
 * 现实教训（2026-11-10 真机）：模型拿到的是工作区相对路径 `blobs/xxx.wav`，
 * 它自己拼成了 `<部署>/blobs/xxx.wav`（少了 `workspace`），于是工具报「文件不存在」。
 * 让模型去猜目录层级是不可靠的，正确的做法是**工具自己按已知根目录找**：
 *
 *   1. 原样（绝对路径）
 *   2. `<部署>/workspace/<相对>` —— bot 工作区，模型看到的相对路径基本都是相对它
 *   3. `<部署>/<相对>`、`<data>/<相对>`、`<repo>/<相对>`
 *   4. 绝对路径但少了 `workspace` 一层：把部署前缀换掉再试
 *   5. 兜底：在工作区里按文件名有界搜索（跳过 .git，深度与条目都有上限）
 *
 * 另外支持 Coopanion 的 blob 句柄（`log:` / `mem:`）——那种情况由调用方先把字节写进临时文件。
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';

import { extForMime } from '../mtproto/client.ts';

export interface SearchRoots {
  /** 部署根（`data/home/companion`）。 */
  botDir: string;
  dataDir: string;
  repoRoot: string;
  /** 临时落盘目录（blob 句柄转文件用）。 */
  mediaDir: string;
}

export type Resolution =
  | { ok: true; path: string; note?: string }
  | { ok: false; error: string };

export function isBlobHandle(raw: string): boolean {
  return /^(log|mem):/i.test(raw.trim());
}

/** 把 blob 句柄的字节落到临时文件，返回路径。 */
export function storeBlob(bytes: Uint8Array, mime: string, mediaDir: string): string {
  mkdirSync(mediaDir, { recursive: true });
  const ext = extForMime(mime) || 'bin';
  const path = join(mediaDir, `blob-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
  writeFileSync(path, bytes);
  return path;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 按已知根目录解析文件。
 * `workspaceFirst` 决定相对路径的优先根——模型看到的相对路径默认相对工作区。
 */
export function resolveLocalFile(raw: string, roots: SearchRoots): Resolution {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (!value) return { ok: false, error: 'file_path 不能为空' };

  const workspace = join(roots.botDir, 'workspace');
  const candidates: string[] = [];

  if (isAbsolute(value)) {
    candidates.push(value);
    const rel = relative(roots.botDir, value);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      // `<部署>/blobs/x.wav` 这种「少一层 workspace」的常见错法
      candidates.push(join(workspace, rel));
    }
  } else {
    candidates.push(join(workspace, value), join(roots.botDir, value), join(roots.dataDir, value), join(roots.repoRoot, value), value);
  }

  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      return { ok: true, path: candidate, ...(candidate === value ? {} : { note: `解析为 ${candidate}` }) };
    }
  }

  const byName = findByName(workspace, basename(value));
  if (byName) return { ok: true, path: byName, note: `按文件名在工作区找到 ${byName}` };

  // 不回显找过的路径与工作区绝对路径：工具结果会进模型上下文，可能被转述到聊天里
  return {
    ok: false,
    error: `文件不存在：${basename(value) || value}（也可给工作区相对路径，或用 telegram_find_local_media 找最近生成的文件）`,
  };
}

/** 有界搜索：深度 ≤ 4、条目 ≤ 3000、跳过 .git 与 node_modules。 */
export function findByName(root: string, name: string, maxDepth = 4): string | null {
  if (!name || !existsSync(root)) return null;
  let budget = 3000;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      budget -= 1;
      if (budget <= 0) return null;
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
      if (entry.isDirectory() && depth < maxDepth) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}

/** 供回执显示：`name (size)`。 */
export function describeFile(path: string): string {
  try {
    const size = statSync(path).size;
    return `${basename(path)} (${(size / 1024).toFixed(0)} KB)`;
  } catch {
    return basename(path);
  }
}

export { extname };
