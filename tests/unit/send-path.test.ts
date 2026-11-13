/**
 * S-01：发送路径必须落在授权目录内，且密钥类文件永远不许外发。
 * 跑法：npx tsx tests/unit/send-path.test.ts
 *
 * 这条测试是 0.26.3 热修的核心：修之前 `telegram_send_media` 能把 session.txt 发出去。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveForSend } from '../../src/resources.ts';

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

const root = mkdtempSync(join(tmpdir(), 'tg-sendpath-'));
const pics = join(root, 'pics');
const dataDir = join(root, 'data', 'telegram');
const mediaDir = join(dataDir, 'media');
mkdirSync(pics, { recursive: true });
mkdirSync(mediaDir, { recursive: true });
writeFileSync(join(pics, 'a.png'), 'png');
writeFileSync(join(pics, '.env'), 'SECRET=1');
writeFileSync(join(pics, 'key.pem'), 'KEY');
writeFileSync(join(dataDir, 'session.txt'), 'SESSION');
writeFileSync(join(mediaDir, 'blob-1.png'), 'blob');

const policy = {
  roots: [pics, mediaDir] as string[],
  denyDirs: [dataDir],
  allowUnder: [mediaDir],
};

try {
  console.log('\n# 正常文件');
  {
    const r = resolveForSend(join(pics, 'a.png'), policy);
    ok('图片放行', r.ok, r.ok ? '' : r.error);
    ok('返回 realpath', r.ok && r.path.toLowerCase().endsWith('a.png'));
    const b = resolveForSend(join(mediaDir, 'blob-1.png'), policy);
    ok('blob 落盘文件放行', b.ok, b.ok ? '' : b.error);
  }

  console.log('\n# 授权目录外');
  {
    const outside = resolveForSend(join(root, 'outside.png'), policy);
    ok('目录外拒绝', !outside.ok);
    ok('错误信息不带绝对路径', !outside.ok && !outside.error.includes(root), outside.ok ? '' : outside.error);
  }

  console.log('\n# 密钥黑名单（即使在授权目录内）');
  {
    const env = resolveForSend(join(pics, '.env'), policy);
    ok('.env 拒绝', !env.ok);
    const pem = resolveForSend(join(pics, 'key.pem'), policy);
    ok('.pem 拒绝', !pem.ok);
  }

  console.log('\n# 数据目录封禁');
  {
    // session.txt 在 denyDirs 里，且不在 allowUnder（media）内
    const session = resolveForSend(join(dataDir, 'session.txt'), {
      roots: [dataDir],
      denyDirs: [dataDir],
      allowUnder: [mediaDir],
    });
    ok('session.txt 拒绝', !session.ok, session.ok ? '被放行了' : session.error);
    const state = resolveForSend(join(dataDir, 'state.json'), {
      roots: [dataDir],
      denyDirs: [dataDir],
      allowUnder: [mediaDir],
    });
    ok('state.json 拒绝', !state.ok);
  }

  console.log('\n# 符号链接指向敏感文件');
  {
    const link = join(pics, 'innocent.png');
    try {
      symlinkSync(join(dataDir, 'session.txt'), link);
      const r = resolveForSend(link, {
        roots: [pics],
        denyDirs: [dataDir],
        allowUnder: [mediaDir],
      });
      ok('链接指到 session.txt 被拒', !r.ok, r.ok ? '被放行了' : r.error);
    } catch {
      // Windows 上没权限建符号链接时跳过（不算失败）
      ok('符号链接用例跳过（无权限）', true);
    }
  }

  console.log('\n# 相对路径与穿越');
  {
    const rel = resolveForSend('a.png', policy);
    ok('相对路径按当前目录解析（不在 roots 内则拒）', !rel.ok || rel.path.startsWith(pics));
    const dotdot = resolveForSend(join(pics, '..', 'data', 'telegram', 'session.txt'), {
      roots: [root],
      denyDirs: [dataDir],
      allowUnder: [mediaDir],
    });
    ok('../ 穿越到 session.txt 被拒', !dotdot.ok, dotdot.ok ? '被放行了' : dotdot.error);
  }

  console.log('\n# 空输入与不存在');
  {
    ok('空路径拒绝', !resolveForSend('', policy).ok);
    const missing = resolveForSend(join(pics, 'nope.png'), policy);
    ok('不存在拒绝', !missing.ok);
    ok('不泄露完整路径', !missing.ok && missing.error === '文件不存在', missing.ok ? '' : missing.error);
  }

  console.log('\n# roots = null（阶段二给主人用）');
  {
    const anywhere = resolveForSend(join(pics, 'a.png'), { roots: null, denyDirs: [] });
    ok('不限路径时放行', anywhere.ok);
    const stillDenied = resolveForSend(join(pics, '.env'), { roots: null, denyDirs: [] });
    ok('但不限路径仍拦密钥', !stillDenied.ok);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
