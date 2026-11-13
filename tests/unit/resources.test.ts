/**
 * 本地资源目录的安全性单测：目录越权、扫描、登记索引。
 * 跑法：npx tsx tests/unit/resources.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KIND_HINT,
  KIND_LABEL,
  RESOURCE_KINDS,
  ResourceIndex,
  inspectDir,
  kindOfFile,
  resolveWithinRoots,
  scanRecent,
} from '../../src/resources.ts';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} — 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'tg-res-'));
const voiceDir = join(root, 'voice');
const outsideDir = join(root, 'outside');
const nested = join(voiceDir, 'nested');
mkdirSync(voiceDir, { recursive: true });
mkdirSync(outsideDir, { recursive: true });
mkdirSync(nested, { recursive: true });

const insideFile = join(voiceDir, 'a.wav');
const nestedFile = join(nested, 'b.ogg');
const outsideFile = join(outsideDir, 'c.wav');
writeFileSync(insideFile, Buffer.alloc(2048, 1));
writeFileSync(nestedFile, Buffer.alloc(1024, 2));
writeFileSync(outsideFile, Buffer.alloc(512, 3));
// 让 a.wav 更"新"
const now = Date.now() / 1000;
utimesSync(insideFile, now, now);
utimesSync(nestedFile, now - 600, now - 600);

console.log('\n# 目录命名与说明');
{
  const labels = RESOURCE_KINDS.map((kind) => KIND_LABEL[kind]);
  ok('7 个目录都有名字', labels.every((label) => !!label));
  ok('7 个目录都有用途说明', RESOURCE_KINDS.every((kind) => !!KIND_HINT[kind]));
  eq('唱歌目录叫法', KIND_LABEL.song, '唱歌目录');
  ok('唱歌目录在列表里', RESOURCE_KINDS.includes('song'));
  eq('表情包目录的叫法', KIND_LABEL.sticker, '表情包目录');
  ok('不再出现「贴纸」字样', !labels.some((label) => label.includes('贴纸')), labels.join(','));
}

console.log('\n# 类型推断');
eq('wav → voice', kindOfFile('x.wav'), 'voice');
eq('png → image', kindOfFile('x.PNG'), 'image');
eq('mp4 → video', kindOfFile('x.mp4'), 'video');
eq('tgs → sticker', kindOfFile('x.tgs'), 'sticker');
eq('未知 → file', kindOfFile('x.bin'), 'file');

console.log('\n# 目录越权（核心安全）');
{
  const roots = [voiceDir];
  const okIn = resolveWithinRoots(insideFile, roots);
  ok('目录内文件放行', okIn.ok);
  const okNested = resolveWithinRoots(nestedFile, roots);
  ok('子目录文件放行', okNested.ok);
  const escape = resolveWithinRoots(join(voiceDir, '..', 'outside', 'c.wav'), roots);
  ok('.. 穿越被拒', !escape.ok, escape.ok ? '' : escape.error);
  const absolute = resolveWithinRoots(outsideFile, roots);
  ok('根目录外的绝对路径被拒', !absolute.ok, absolute.ok ? '' : absolute.error);
  const sibling = resolveWithinRoots(join(root, 'outside'), roots);
  ok('兄弟目录被拒', !sibling.ok);
  const noRoots = resolveWithinRoots(insideFile, []);
  ok('没有配置目录时直接拒', !noRoots.ok);
  // 错误信息会进模型上下文，不能回显任何绝对路径
  ok('错误信息不回显根目录', !absolute.ok && !absolute.error.includes(voiceDir), absolute.ok ? '' : absolute.error);
}

console.log('\n# 扫描');
{
  const files = scanRecent(voiceDir, 10);
  eq('扫到 1 个（不递归）', files.length, 1);
  eq('文件名正确', files[0]?.name, 'a.wav');
  eq('类型正确', files[0]?.kind, 'voice');
  eq('不存在的目录返回空', scanRecent(join(root, 'nope'), 5).length, 0);
  eq('limit 生效', scanRecent(voiceDir, 1).length, 1);
}

console.log('\n# 目录状态');
{
  const status = inspectDir('voice', voiceDir);
  ok('已配置', status.configured);
  ok('存在', status.exists);
  ok('可写', status.writable);
  eq('文件数', status.files, 1);
  eq('最新文件', status.newest?.name, 'a.wav');

  const missing = inspectDir('image', join(root, 'not-here'));
  ok('不存在时 exists=false', !missing.exists);

  const empty = inspectDir('video', '');
  eq('未配置时 configured=false', empty.configured, false);
}

console.log('\n# 登记索引');
{
  const file = join(root, 'resources.json');
  const index = new ResourceIndex(file);
  const entry = index.register({
    path: insideFile,
    name: 'a.wav',
    kind: 'voice',
    size: 2048,
    mtime: Date.now(),
    source: 'gpt-sovits',
  });
  ok('登记返回记录', entry.source === 'gpt-sovits');
  eq('列表能取到', index.list().length, 1);
  eq('按 kind 过滤', index.list({ kind: 'voice' }).length, 1);
  eq('按 kind 过滤（其他）', index.list({ kind: 'image' }).length, 0);
  eq('按名字过滤', index.list({ query: 'a.w' }).length, 1);
  eq('过滤不到', index.list({ query: 'zzz' }).length, 0);

  index.register({ path: insideFile, name: 'a.wav', kind: 'voice', size: 2048, mtime: Date.now(), source: 'repeat' });
  eq('同一路径覆盖不重复', index.list().length, 1);
  eq('覆盖后来源更新', index.list()[0]?.source, 'repeat');

  const reopened = new ResourceIndex(file);
  eq('落盘后能重新读到', reopened.list().length, 1);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
rmSync(root, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
