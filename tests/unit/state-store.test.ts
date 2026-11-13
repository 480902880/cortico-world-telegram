/**
 * R-01：state.json 攒批写盘 + 游标裁剪。
 * 跑法：npx tsx tests/unit/state-store.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateStore } from '../../src/mtproto/session-store.ts';
import type { TelegramPaths } from '../../src/mtproto/session-store.ts';

let passed = 0;
let failed = 0;

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

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'tg-state-'));
const paths = {
  dir: root,
  session: join(root, 'session.txt'),
  state: join(root, 'state.json'),
  lock: join(root, 'instance.lock'),
  media: join(root, 'media'),
} as unknown as TelegramPaths;
mkdirSync(root, { recursive: true });

interface Write { body: string; }
function makeStore(extra: { debounceMs?: number; keepDays?: number; maxChats?: number; now?: () => number } = {}) {
  const writes: Write[] = [];
  const store = new StateStore(paths, {
    debounceMs: 10,
    now: () => 1_000_000_000,
    write: async (_path, body) => {
      writes.push({ body });
    },
    ...extra,
  });
  return { store, writes };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

try {
  console.log('\n# 攒批：多次 bump 只写一次');
  {
    const { store, writes } = makeStore();
    for (let i = 1; i <= 200; i += 1) store.bump(42, i, 1_000_000_000);
    eq('写盘前 0 次', writes.length, 0);
    await sleep(40);
    eq('一个窗口内只写 1 次', writes.length, 1);
    const parsed = JSON.parse(writes[0]!.body) as { chats: Record<string, { lastSeenId: number }> };
    eq('写的是最后一条游标', parsed.chats['42']?.lastSeenId, 200);
  }

  console.log('\n# 只前进不后退');
  {
    const { store, writes } = makeStore();
    store.bump(7, 100, 1_000_000_000);
    store.bump(7, 50, 1_000_000_000);
    await store.close();
    const parsed = JSON.parse(writes.at(-1)!.body) as { chats: Record<string, { lastSeenId: number }> };
    eq('小 id 不会覆盖大 id', parsed.chats['7']?.lastSeenId, 100);
  }

  console.log('\n# close() 会立刻落盘');
  {
    const { store, writes } = makeStore();
    store.bump(1, 1, 1_000_000_000);
    await store.close();
    eq('不用等定时器就写了', writes.length, 1);
    await store.close();
    eq('重复 close 不重复写', writes.length, 1);
  }

  console.log('\n# 裁剪：过期游标被丢掉');
  {
    const now = 1_000_000_000;
    const { store, writes } = makeStore({ now: () => now, keepDays: 1 });
    store.bump(1, 5, now - 10 * 24 * 3600_000); // 10 天前
    store.bump(2, 6, now); // 现在
    await store.close();
    const parsed = JSON.parse(writes.at(-1)!.body) as { chats: Record<string, unknown> };
    eq('过期的没了', Object.keys(parsed.chats), ['2']);
  }

  console.log('\n# 裁剪：数量上限');
  {
    const now = 1_000_000_000;
    const { store, writes } = makeStore({ now: () => now, maxChats: 3 });
    for (let i = 1; i <= 10; i += 1) store.bump(i, i, now - i * 1000);
    await store.close();
    const parsed = JSON.parse(writes.at(-1)!.body) as { chats: Record<string, unknown> };
    eq('只留最近 3 个', Object.keys(parsed.chats).length, 3);
  }

  console.log('\n# 读回旧文件');
  {
    writeFileSync(paths.state, JSON.stringify({ chats: { 9: { lastSeenId: 77, lastSeenTs: 5 } } }), 'utf8');
    const { store } = makeStore();
    eq('能读到上次的游标', store.cursor(9)?.lastSeenId, 77);
    eq('没记录的会话为空', store.cursor(123), undefined);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
