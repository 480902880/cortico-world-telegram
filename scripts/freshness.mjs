/**
 * P-01：产物新鲜度校验。
 *
 * 解决的是这个真实事故：改了 `src/webui/client.ts` 却忘了 `npm run build:webui`，
 * 打出来的包里 `dist/webui.js` 还是旧代码——面板看上去正常，功能却是死的，
 * 装上去的人完全不知道发生了什么。
 *
 * 做法：构建时记下「输入源码的指纹」，打包时重算一次比对。
 * 指纹只看内容（不看 mtime），所以切分支、touch 文件都不会误报。
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 递归列出目录下的文件（按路径排序，保证指纹稳定）。 */
export function listFiles(dir, filter = () => true) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && filter(full)) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * 计算一组文件的指纹：路径 + 内容一起进哈希。
 * 路径进哈希是为了"新增/删除文件"也能被发现（只哈希内容的话，删一个文件指纹不变）。
 */
export function fingerprintFiles(root, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/');
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 32);
}

/** 面板产物的输入：src/webui 下全部 ts，加上它 import 的兄弟目录（inbound/prompt 等纯类型不会进产物，但一起算更稳）。 */
export function webuiSourceFiles(root) {
  return [
    ...listFiles(join(root, 'src/webui'), (file) => file.endsWith('.ts')),
    ...listFiles(join(root, 'src/prompt'), (file) => file.endsWith('.md')),
  ];
}

/** 自描述文件的输入：工具声明、定义、配置、清单。 */
export function describeSourceFiles(root) {
  const one = (name) => (existsSync(join(root, name)) ? [join(root, name)] : []);
  return [
    ...one('src/tools.ts'),
    ...one('src/definition.ts'),
    ...one('src/config.ts'),
    ...one('package.json'),
  ];
}

export function metaPath(root) {
  return join(root, 'dist/webui.meta.json');
}

/** 构建后调用：写下当前指纹。 */
export function writeMeta(root, { writeFile, sourceHash, outFile }) {
  const files = webuiSourceFiles(root);
  const meta = {
    sourceHash,
    builtAt: new Date().toISOString(),
    inputs: files.length,
    out: relative(root, outFile).replace(/\\/g, '/'),
    outSize: statSync(outFile).size,
  };
  writeFile(metaPath(root), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return meta;
}

/**
 * 打包前调用：源码指纹和构建时不一致 → 抛错（而不是打出一个死包）。
 * 返回 { ok, reason }，由调用方决定说什么话。
 */
export function checkWebuiFreshness(root) {
  const meta = metaPath(root);
  if (!existsSync(meta)) {
    return { ok: false, reason: '缺少 dist/webui.meta.json（从没构建过面板）' };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(meta, 'utf8'));
  } catch {
    return { ok: false, reason: 'dist/webui.meta.json 读不出来（内容损坏）' };
  }
  const current = fingerprintFiles(root, webuiSourceFiles(root));
  if (parsed.sourceHash !== current) {
    return { ok: false, reason: '面板源码改过了，但 dist/webui.js 还是旧的' };
  }
  const outFile = join(root, String(parsed.out ?? 'dist/webui.js'));
  if (!existsSync(outFile)) return { ok: false, reason: 'dist/webui.js 不见了' };
  return { ok: true, meta: parsed };
}

/** 自描述文件是否比它的输入旧（简单用 mtime 比：describe 是生成物，不必存指纹）。 */
export function checkDescribeFreshness(root) {
  const target = join(root, 'describe.json');
  if (!existsSync(target)) return { ok: false, reason: '缺少 describe.json（从没生成过自描述）' };
  const targetAt = statSync(target).mtimeMs;
  const newer = describeSourceFiles(root).filter((file) => statSync(file).mtimeMs > targetAt + 1000);
  if (newer.length) {
    return {
      ok: false,
      reason: `describe.json 比这些文件旧：${newer.map((f) => relative(root, f).replace(/\\/g, '/')).join('、')}`,
    };
  }
  return { ok: true };
}
