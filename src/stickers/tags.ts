/**
 * 本地表情的语义标签。
 *
 * 为什么要它：文件名是 `sticker-xxx.jpg`，模型看不出"这图什么意思、什么时候该发"。
 * 标签由模型看图后写进来，之后选表情就能按**意思**挑，而不是按文件名瞎猜。
 *
 * 存储：`<dataDir>/telegram/sticker-tags.json`
 * 结构：{ [文件名]: { tags, usage, size, updatedAt } }
 * `size` 用来判断文件被替换过——大小变了就当作没打过标签。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface StickerTag {
  /** 这张图是什么（可多个词）。 */
  tags: string[];
  /** 什么时候适合发。 */
  usage: string;
  size: number;
  updatedAt: number;
}

export type StickerTagMap = Record<string, StickerTag>;

export class StickerTagStore {
  private cache: StickerTagMap | null = null;
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'telegram', 'sticker-tags.json');
  }

  all(): StickerTagMap {
    if (this.cache) return this.cache;
    try {
      if (!existsSync(this.path)) {
        this.cache = {};
        return this.cache;
      }
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as StickerTagMap;
      this.cache = raw && typeof raw === 'object' ? raw : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  get(name: string): StickerTag | undefined {
    return this.all()[name];
  }

  /** 写入一批标签；返回真正新增/更新的条数。 */
  save(entries: Array<{ name: string; tags: string[]; usage: string; size: number }>): number {
    const map = { ...this.all() };
    let changed = 0;
    for (const entry of entries) {
      const name = entry.name.trim();
      if (!name) continue;
      const tags = entry.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
      if (!tags.length && !entry.usage.trim()) continue;
      map[name] = {
        tags,
        usage: entry.usage.trim(),
        size: entry.size,
        updatedAt: Date.now(),
      };
      changed += 1;
    }
    this.cache = map;
    this.flush();
    return changed;
  }

  private flush(): void {
    const text = JSON.stringify(this.cache ?? {}, null, 2);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, text, 'utf8');
      renameSync(tmp, this.path);
    } catch {
      // 写不进就算了：标签是增强信息，不该打断消息处理
    }
  }

  /**
   * 哪些文件还没打标签（或文件被换过）。
   * `files` 必须带 size，用来判断内容是否变化。
   */
  pending<T extends { name: string; size: number }>(files: readonly T[]): T[] {
    const map = this.all();
    return files.filter((file) => {
      const tag = map[file.name];
      return !tag || tag.size !== file.size;
    });
  }

  /** 统计：总数 / 已标 / 待标。 */
  summary(files: readonly { name: string; size: number }[]): { total: number; tagged: number; pending: number } {
    const map = this.all();
    let tagged = 0;
    for (const file of files) {
      const tag = map[file.name];
      if (tag && tag.size === file.size) tagged += 1;
    }
    return { total: files.length, tagged, pending: files.length - tagged };
  }
}

/** 给模型看的一句话描述（选表情时用它比对意思）。 */
export function describeTag(name: string, tag: StickerTag | undefined): string {
  if (!tag) return `${name}（未标注）`;
  const tags = tag.tags.length ? tag.tags.join('、') : '无关键词';
  return `${name}【${tags}】${tag.usage ? ` — ${tag.usage}` : ''}`;
}
