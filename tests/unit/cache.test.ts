/**
 * 媒体缓存清理的单测（真建目录、真删文件）。
 * 跑法：npx tsx tests/unit/cache.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cacheStats, clearMediaDir, humanSize, listFiles, pruneMediaDir, selectExpired } from '../../src/media/cache.ts';

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
    console.log(`  FAIL ${name} — 实际 ${JSON.stringify(actual)}`);
  }
}

console.log('\n# 体积格式');
eq('0', humanSize(0), '0 B');
eq('1024', humanSize(1024), '1 KB');
eq('1.5MB', humanSize(1.5 * 1024 * 1024), '1.5 MB');

console.log('\n# 纯函数：过期筛选');
{
  const now = 1_760_000_000_000;
  const files = [
    { path: 'a', size: 1, mtime: now - 1000 },
    { path: 'b', size: 2, mtime: now - 10 * 3600_000 },
    { path: 'c', size: 3, mtime: now - 100 * 3600_000 },
  ];
  eq('保留 24h → 只删最老的', selectExpired(files, 24 * 3600_000, now).map((f) => f.path), ['c']);
  eq('保留 1h → 删两个', selectExpired(files, 3600_000, now).map((f) => f.path), ['b', 'c']);
  eq('keepMs<=0 → 一个都不删', selectExpired(files, 0, now), []);
}

console.log('\n# 真删（建临时目录）');
{
  const root = mkdtempSync(join(tmpdir(), 'tg-cache-'));
  const oldDir = join(root, '123');
  mkdirSync(oldDir, { recursive: true });
  const oldFile = join(oldDir, 'old.jpg');
  const newFile = join(oldDir, 'new.jpg');
  writeFileSync(oldFile, Buffer.alloc(2048, 1));
  writeFileSync(newFile, Buffer.alloc(1024, 2));
  const oldDate = (Date.now() - 100 * 3600_000) / 1000;
  utimesSync(oldFile, oldDate, oldDate);

  eq('递归列到 2 个文件', listFiles(root).length, 2);

  const result = pruneMediaDir(root, 24);
  eq('删掉 1 个', result.removed, 1);
  eq('释放 2048 字节', result.bytes, 2048);
  ok('老文件没了', !existsSync(oldFile));
  ok('新文件还在', existsSync(newFile));

  const again = pruneMediaDir(root, 24);
  eq('再跑一次没有可删的', again.removed, 0);

  const keepAll = pruneMediaDir(root, 0);
  eq('保留 0 小时 → 不清理', keepAll.removed, 0);
  ok('文件仍在', existsSync(newFile));

  eq('统计文件数', cacheStats(root).files, 1);
  ok('统计字节数 > 0', cacheStats(root).bytes > 0);

  const cleared = clearMediaDir(root);
  eq('全清删掉 1 个', cleared.removed, 1);
  eq('清完是空的', cacheStats(root).files, 0);

  const noDir = pruneMediaDir(join(root, 'nope'), 24);
  eq('目录不存在也不报错', noDir.removed, 0);

  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
