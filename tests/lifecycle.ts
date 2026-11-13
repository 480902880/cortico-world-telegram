/**
 * 生命周期测试：不联网、不需要账号。
 * 覆盖 start/stop、双开锁释放、未登录时的工具回执。
 * 跑法：npx tsx tests/lifecycle.ts
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { telegramDefaults } from '../src/config.ts';
import { TelegramWorld } from '../src/world.ts';

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

const dataDir = mkdtempSync(join(tmpdir(), 'tg-life-'));
const pushed: string[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
const host = {
  log,
  store: {},
  pushEvent: async (e: any) => {
    pushed.push(e.type);
    return { ...e, cursor: pushed.length, origin: 'external' };
  },
  drainPendingEvents: async () => [],
  modelFacts: { accepts: () => true },
  blob: () => null,
  reportUsage() {},
};

function makeWorld(): TelegramWorld {
  return new TelegramWorld({
    id: 'telegram',
    cfg: telegramDefaults() as any,
    timezone: 'Asia/Shanghai',
    botName: 'probe',
    botDir: dataDir,
    packageDir: dataDir,
    dataDir,
    repoRoot: dataDir,
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  } as any);
}

async function main(): Promise<void> {
  console.log('\n# start / stop');
  const w1 = makeWorld();
  await w1.start(host as any);
  ok('start 不抛错', true);
  const lock = join(dataDir, 'telegram', 'instance.lock');
  ok('已写双开锁', existsSync(lock));

  const lamps = w1.webUi('zh').lamps ?? [];
  ok('未登录时连接灯 offline', lamps.some((l) => l.label === '连接' && l.state === 'offline'));
  ok('未登录时登录灯 offline', lamps.some((l) => l.label === '登录' && l.state === 'offline'));
  const vars = await w1.envPromptVars();
  ok('未登录时模板变量仍可用（不返回 null）', !!vars && typeof vars === 'object');
  ok('未登录有明确说明', String(vars['telegram.identity'] ?? '').includes('未登录'), String(vars['telegram.identity'] ?? ''));
  ok('八件套都在', ['telegram.identity', 'telegram.conversations', 'telegram.contacts', 'telegram.resources', 'telegram.media', 'telegram.stickers', 'telegram.capabilities', 'telegram.preferences'].every((key) => key in vars));

  const read = w1.tools().find((t) => t.name === 'telegram_read_messages')!;
  const receipt = await read.handler({ chat: '123456789' }, { role: 'main', log } as any);
  const text = typeof receipt === 'string' ? receipt : receipt.text;
  ok('未登录时读消息被拒', /未登录/.test(text), text);
  ok('回执标记失败', typeof receipt !== 'string' && receipt.failed === true);

  await w1.stop();
  ok('stop 后锁已释放', !existsSync(lock));

  console.log('\n# 停掉之后能重新启动（框架重启路径）');
  const w2 = makeWorld();
  await w2.start(host as any);
  ok('二次 start 不抛错', true);
  await w2.stop();

  console.log('\n# 面板方法在未登录时不炸');
  const w3 = makeWorld();
  await w3.start(host as any);
  const invoke = w3.webUi('zh').invoke!;
  const status = (await invoke('status', 'status', [])) as any;
  ok('status 返回连接态', status?.connection?.status === 'offline');
  ok('status 不泄露 hash', !JSON.stringify(status).includes('b18441a1ff607e10a989891a5462e627'));
  ok('status 带凭据来源', typeof status?.credentials?.label === 'string');
  const bad = (await invoke('login', 'start_login', ['abc'])) as any;
  ok('非法手机号不会进入 code_sent', bad?.step !== 'code_sent', JSON.stringify(bad?.step));
  ok('给出手机号格式提示', /手机号/.test(String(bad?.detail ?? '')), String(bad?.detail));
  await w3.stop();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
