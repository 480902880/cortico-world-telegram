/**
 * S-09：Windows 上的文件权限加固。
 *
 * 现实：`fs.chmodSync(file, 0o600)` 在 Windows 上**基本无效**——它只能改只读位，
 * 真正的访问控制由 ACL 决定。所以 `session.txt`（登录态，等于账号密码）在 Windows
 * 上默认是「继承父目录权限」，同机其它用户/管理员组都能读。
 *
 * 做法：用 `icacls` 关掉继承，只留三个主体：
 *  - 当前用户（完全控制）
 *  - SYSTEM（S-1-5-18）
 *  - Administrators（S-1-5-32-544）
 * 用 **SID 而不是名字**，因为中文/其它语言的 Windows 上组名是本地化的，
 * 写 "Administrators" 会失败。
 *
 * 全程 best-effort：失败只记日志，绝不影响登录流程（拿不到 icacls 的机器也得能用）。
 */

import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

/** 本地管理员组与 SYSTEM 的固定 SID。 */
const SID_SYSTEM = '*S-1-5-18';
const SID_ADMINS = '*S-1-5-32-544';

export interface AclStep {
  args: string[];
  /** 这一步在干什么（失败时写进日志）。 */
  what: string;
}

/**
 * 生成加固步骤（纯函数，便于测试）。
 * `user` 形如 `DOMAIN\name` 或 `name`；为空则跳过"本人"这一条。
 */
export function aclPlan(file: string, user: string): AclStep[] {
  const steps: AclStep[] = [
    { args: [file, '/inheritance:r'], what: '关闭权限继承' },
  ];
  const grants = [`${SID_SYSTEM}:(F)`, `${SID_ADMINS}:(F)`];
  if (user.trim()) grants.push(`${user.trim()}:(F)`);
  steps.push({ args: [file, '/grant:r', ...grants], what: '只授权本人/SYSTEM/管理员' });
  return steps;
}

/** 当前用户写成 `DOMAIN\name`（icacls 认这种形式）；拿不到就只返回用户名。 */
export function currentUserName(): string {
  const name = process.env.USERNAME?.trim() || userInfo().username?.trim() || '';
  const domain = process.env.USERDOMAIN?.trim() || '';
  if (!name) return '';
  return domain ? `${domain}\\${name}` : name;
}

function runOnce(args: string[], timeoutMs = 8000): Promise<{ code: number; err?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code: number, err?: string): void => {
      if (done) return;
      done = true;
      resolve(err ? { code, err } : { code });
    };
    try {
      const child = spawn('icacls', args, { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已经退出了
        }
        finish(-1, 'icacls 超时');
      }, timeoutMs);
      timer.unref?.();
      child.on('error', (error) => {
        clearTimeout(timer);
        finish(-1, error.message);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        finish(code ?? -1);
      });
    } catch (error) {
      finish(-1, error instanceof Error ? error.message : String(error));
    }
  });
}

export interface HardenResult {
  ok: boolean;
  /** 失败时的原因（给日志用）。 */
  reason?: string;
  /** 明确跳过的情况（非 Windows / 文件不存在）。 */
  skipped?: boolean;
}

/** 给一个文件加 ACL（只在 Windows 上做；其它平台直接跳过）。 */
export async function hardenFileAcl(file: string, user = currentUserName()): Promise<HardenResult> {
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  for (const step of aclPlan(file, user)) {
    const out = await runOnce(step.args);
    if (out.code !== 0) {
      return { ok: false, reason: `${step.what}失败（${out.err ?? `exit ${out.code}`}）` };
    }
  }
  return { ok: true };
}

/** 批量加固；返回逐个结果，调用方自己决定怎么记日志。 */
export async function hardenFilesAcl(files: string[]): Promise<Array<{ file: string } & HardenResult>> {
  const out: Array<{ file: string } & HardenResult> = [];
  for (const file of files) {
    out.push({ file, ...(await hardenFileAcl(file)) });
  }
  return out;
}
