/**
 * 文件路径解析的单测——复刻真机那次失败：模型给了 `<部署>/blobs/x.wav`，
 * 文件其实在 `<部署>/workspace/blobs/x.wav`。
 * 跑法：npx tsx tests/unit/source.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findByName, isBlobHandle, resolveLocalFile, storeBlob } from '../../src/media/source.ts';

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

const root = mkdtempSync(join(tmpdir(), 'tg-src-'));
const botDir = join(root, 'companion');
const workspace = join(botDir, 'workspace');
const dataDir = join(botDir, 'data');
const mediaDir = join(dataDir, 'telegram', 'media');
const wavInWorkspace = join(workspace, 'blobs', 'tg-voice-test.wav');

mkdirSync(join(workspace, 'blobs'), { recursive: true });
mkdirSync(join(workspace, 'gpt-sovits', 'out'), { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(mediaDir, { recursive: true });
writeFileSync(wavInWorkspace, Buffer.alloc(340 * 1024, 1));
writeFileSync(join(workspace, 'gpt-sovits', 'out', 'deep.wav'), Buffer.alloc(2048, 2));

const roots = { botDir, dataDir, repoRoot: botDir, mediaDir };

console.log('\n# 真机复刻：工作区相对路径');
{
  const r = resolveLocalFile('blobs/tg-voice-test.wav', roots);
  ok('相对路径按工作区解析', r.ok && r.path === wavInWorkspace, r.ok ? r.path : r.error);
}

console.log('\n# 真机复刻：少一层 workspace 的绝对路径');
{
  const wrong = join(botDir, 'blobs', 'tg-voice-test.wav');
  const r = resolveLocalFile(wrong, roots);
  ok('自动补上 workspace', r.ok && r.path === wavInWorkspace, r.ok ? r.path : r.error);
}

console.log('\n# 正确的绝对路径');
{
  const r = resolveLocalFile(wavInWorkspace, roots);
  ok('原样返回', r.ok && r.path === wavInWorkspace && !r.note, r.ok ? String(r.note) : r.error);
}

console.log('\n# 兜底：只给文件名');
{
  const r = resolveLocalFile('deep.wav', roots);
  ok('在工作区里按名字找到', r.ok && r.path.endsWith(join('gpt-sovits', 'out', 'deep.wav')), r.ok ? r.path : r.error);
}

console.log('\n# 找不到时的报错');
{
  const r = resolveLocalFile('nope.wav', roots);
  ok('失败', !r.ok);
  ok('报错不泄露找过的路径', !r.ok && !r.error.includes('找过'), r.ok ? '' : r.error);
  ok('报错不泄露工作区绝对路径', !r.ok && !r.error.includes(workspace), r.ok ? '' : r.error);
  ok('报错给出替代做法', !r.ok && r.error.includes('find_local_media'), r.ok ? '' : r.error);
}

console.log('\n# blob 句柄');
{
  ok('识别 log:', isBlobHandle('log:abc'));
  ok('识别 mem:', isBlobHandle('mem:abc'));
  ok('普通路径不算句柄', !isBlobHandle('C:/x/y.wav'));
  const path = storeBlob(new Uint8Array([1, 2, 3]), 'audio/ogg', mediaDir);
  ok('落盘成 .ogg', path.endsWith('.ogg') && resolveLocalFile(path, roots).ok);
}

console.log('\n# findByName 边界');
{
  ok('空名返回 null', findByName(workspace, '') === null);
  ok('不存在的根返回 null', findByName(join(root, 'nope'), 'x.wav') === null);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
rmSync(root, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
