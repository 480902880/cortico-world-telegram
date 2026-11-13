/**
 * S-07：资源目录的防手滑校验。
 *
 * 面板上「媒体目录」填一个路径就保存——但如果填的是 `C:\`、`C:\Windows`、
 * `%USERPROFILE%` 这种宽目录，等于把整块盘交给"查找本地媒体 / 发送文件"的扫描与发送逻辑。
 * 虽然发送侧还有黑名单兜底（S-01），但**宽目录本身就不该被接受**：扫一次要几秒，
 * 索引会塞满无关文件，还会把私人文件暴露成"可以发出去"的候选。
 *
 * 这里只做"明显不该填的"拦截，正常子目录一律放行，避免误伤。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

export type DirCheck = { ok: true; path: string } | { ok: false; reason: string };

function norm(value: string): string {
  const unified = resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/** 系统目录清单（存在才比较，避免在别的平台上乱拦）。 */
function systemRoots(): string[] {
  const names = ['WINDIR', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData'];
  return names
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value && isAbsolute(value)))
    .map(norm);
}

/** 用户主目录（`C:\Users\xxx` / `/home/xxx`）——允许它的子目录，不允许它本身。 */
function homeRoots(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME;
  return home && isAbsolute(home) ? [norm(home)] : [];
}

/**
 * 校验一个资源目录能不能用。
 *
 * 拒绝：盘符根（`C:\`）、UNC 共享根、系统目录及其子目录、用户主目录本身。
 * 允许：普通子目录（例如 `D:\Ai\rvc\output`）。
 */
export function checkResourceDir(raw: string): DirCheck {
  const value = (raw ?? '').trim();
  if (!value) return { ok: false, reason: '路径为空' };
  if (!isAbsolute(value)) return { ok: false, reason: '要填绝对路径（例如 D:\\output）' };

  const parsed = parse(value);
  // `C:\` 或 `/` 这种本身就是根的
  if (norm(value) === norm(parsed.root)) {
    return { ok: false, reason: '这是盘符根目录，太宽了；请填具体的子目录' };
  }
  // UNC：`\\server\share` 的根
  if (value.startsWith('\\\\')) {
    const parts = value.replace(/^\\\\/, '').split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) return { ok: false, reason: '这是网络共享的根目录，太宽了' };
  }

  if (!existsSync(value)) return { ok: false, reason: '这个路径不存在' };
  try {
    if (!statSync(value).isDirectory()) return { ok: false, reason: '这是文件，不是目录' };
  } catch {
    return { ok: false, reason: '这个路径读不了（权限不足？）' };
  }

  const target = norm(value);
  for (const root of systemRoots()) {
    if (target === root || target.startsWith(`${root}${sep}`)) {
      return { ok: false, reason: '系统目录不能当资源目录' };
    }
  }
  for (const home of homeRoots()) {
    if (target === home) return { ok: false, reason: '用户主目录本身太宽，请选它下面的具体文件夹' };
  }
  return { ok: true, path: resolve(value) };
}

/** 目录里文件特别多时给一句提醒（不拦，只提醒）。 */
export function dirSizeHint(dir: string, limit = 5000): string | undefined {
  try {
    let count = 0;
    // 只看一层：递归数文件在大目录上会很慢
    const stack = [dir];
    while (stack.length && count <= limit) {
      const current = stack.pop()!;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) stack.push(`${current}${sep}${entry.name}`);
        else count += 1;
        if (count > limit) break;
      }
    }
    return count > limit ? `这个目录文件很多（>${limit}），扫描会慢，建议选更具体的子目录` : undefined;
  } catch {
    return undefined;
  }
}

/** 目录的显示名（面板/日志用）：末两级，避免暴露完整路径。 */
export function dirLabel(dir: string): string {
  const clean = resolve(dir);
  const parent = dirname(clean);
  return parent === clean ? clean : `${parent.split(sep).pop()}${sep}${clean.split(sep).pop()}`;
}
