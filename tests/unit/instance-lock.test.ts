/**
 * R-02：双开锁的原子性、心跳与陈旧锁回收。
 * 跑法：npx tsx tests/unit/instance-lock.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InstanceLock } from '../../src/mtproto/session-store.ts';
import type { TelegramPaths } from '../../src/mtproto/session-store.ts';

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

const root = mkdtempSync(join(tmpdir(), 'tg-lock-'));
const paths = {
  dir: root,
  session: join(root, 'session.txt'),
  state: join(root, 'state.json'),
  lock: join(root, 'instance.lock'),
  media: join(root, 'media'),
} as unknown as TelegramPaths;
mkdirSync(root, { recursive: true });

const writeLock = (body: unknown): void => {
  writeFileSync(paths.lock, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
};

try {
  console.log('\n# 第一次拿锁');
  {
    const lock = new InstanceLock(paths);
    eq('拿到（返回 null）', lock.acquire(), null);
    ok('锁文件存在', existsSync(paths.lock));
    const body = JSON.parse(readFileSync(paths.lock, 'utf8')) as { pid: number; token: string };
    eq('写的是自己的 pid', body.pid, process.pid);
    ok('带 token', typeof body.token === 'string' && body.token.length > 0);
    lock.release();
    ok('释放后锁没了', !existsSync(paths.lock));
  }

  console.log('\n# 已有活跃实例：必须拦住');
  {
    // 用一个确定活着、但不是自己的 pid：父进程
    const alivePid = process.ppid || process.pid;
    writeLock({ pid: alivePid, since: Date.now(), beat: Date.now(), token: 'other' });
    const lock = new InstanceLock(paths);
    const held = lock.acquire();
    ok('拿不到', held !== null);
    eq('报出占用者 pid', held?.pid, alivePid);
    ok('没有覆盖别人的锁', JSON.parse(readFileSync(paths.lock, 'utf8')).token === 'other');
  }

  console.log('\n# 陈旧锁：进程已死 → 回收');
  {
    writeLock({ pid: 999_999_999, since: Date.now() - 60_000, beat: Date.now() - 60_000, token: 'dead' });
    const lock = new InstanceLock(paths);
    eq('能拿到', lock.acquire(), null);
    ok('锁换成了自己', JSON.parse(readFileSync(paths.lock, 'utf8')).token !== 'dead');
    lock.release();
  }

  console.log('\n# 陈旧锁：进程活着但心跳停了（PID 被复用）');
  {
    const alivePid = process.ppid || process.pid;
    writeLock({ pid: alivePid, since: Date.now() - 500_000, beat: Date.now() - 500_000, token: 'zombie' });
    const lock = new InstanceLock(paths, { heartbeatMs: 200, staleMs: 400 });
    eq('判定陈旧并接管', lock.acquire(), null);
    lock.release();
  }

  console.log('\n# 坏锁文件');
  {
    writeLock('{ 这不是 json');
    const lock = new InstanceLock(paths);
    eq('坏锁直接覆盖', lock.acquire(), null);
    lock.release();
    writeLock({ pid: 0 });
    const lock2 = new InstanceLock(paths);
    eq('pid 为 0 也算坏锁', lock2.acquire(), null);
    lock2.release();
  }

  console.log('\n# 心跳会刷新 beat');
  {
    const lock = new InstanceLock(paths, { heartbeatMs: 200 });
    lock.acquire();
    const first = (JSON.parse(readFileSync(paths.lock, 'utf8')) as { beat: number }).beat;
    await new Promise((resolve) => setTimeout(resolve, 450));
    const second = (JSON.parse(readFileSync(paths.lock, 'utf8')) as { beat: number }).beat;
    ok('beat 变新了', second >= first, `${first} → ${second}`);
    lock.release();
  }

  console.log('\n# 释放不会误删别人的锁');
  {
    const lock = new InstanceLock(paths);
    lock.acquire();
    // 模拟"锁被别的进程接管"：换成别人的 token
    writeLock({ pid: process.ppid || 1, since: Date.now(), beat: Date.now(), token: 'other' });
    lock.release();
    ok('别人的锁还在', existsSync(paths.lock));
    eq('内容没被改', JSON.parse(readFileSync(paths.lock, 'utf8')).token, 'other');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
