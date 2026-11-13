/**
 * 依赖自检与一键安装。
 *
 * 背景：扩展源码可以只有 200 KB，但跑起来需要 60 MB 依赖（teleproto + tsx + typescript…）。
 * 让人先 `npm install` 再回来点登录，体验太差——所以这里把"装依赖"做成面板上的一个按钮：
 *
 *  - `probeDeps()` 只看本地文件，判断依赖/构建产物齐不齐（不联网、不执行 npm）
 *  - `DepsInstaller` 负责跑 `npm install` 和 `npm run build:webui`，把输出留在环形缓冲里
 *
 * 注意：安装是一次性的、会写 `node_modules/`，所以同一时间只允许一个实例在跑。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DepsStatus {
  /** node 版本号，例如 `v20.11.0`。 */
  node: string;
  /** 三个运行时依赖是否落地。 */
  hasNodeModules: boolean;
  /** 缺哪些（人话）。 */
  missing: string[];
  /** 面板产物是否已构建。 */
  hasDist: boolean;
  /** 全齐 = 可以登录。 */
  ready: boolean;
  /** 正在安装中。 */
  installing: boolean;
  /** 会用哪个包管理器装（面板上直接显示，省得用户猜）。 */
  manager?: string;
  /** 一个都找不到时的说明。 */
  managerProblem?: string;
}

/**
 * 找依赖实际落在哪一层。
 *
 * Node 解析规则是从当前目录逐级向上找 `node_modules`，所以不管是
 * `<extensions>/node_modules/<pkg>/node_modules`（本包自装）
 * 还是 `<extensions>/node_modules`（包管理器装的），都能被解析到。
 * 只查本包目录会误报"缺依赖"。
 */
export function findDepsDir(packageDir: string, names: readonly string[]): { dir: string | null; missing: string[] } {
  const candidates: string[] = [];
  let dir = packageDir;
  for (let depth = 0; depth < 5; depth += 1) {
    candidates.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    const modulesDir = join(candidate, 'node_modules');
    const missing = names.filter((name) => !existsSync(join(modulesDir, name)));
    if (missing.length === 0) return { dir: modulesDir, missing: [] };
  }
  // 一层都没有全的：报本包目录缺了什么（最贴近用户理解）
  const own = join(packageDir, 'node_modules');
  return { dir: null, missing: names.filter((name) => !existsSync(join(own, name))) };
}

/**
 * 运行期真正会被 import 的包。
 * 只有 teleproto——GramJS（npm 包 `telegram`）已被官方归档并在 npm 标了 deprecated，
 * 我们不再支持那个后端（`MT_LIB` 开关已删除）。
 */
export function runtimeDeps(): string[] {
  return ['teleproto'];
}

/** 本包的包名，用来确认"往上找到的目录确实是我自己"。 */
const PACKAGE_NAME = 'cortico-world-telegram';

/**
 * 找出真正的包根目录。
 *
 * **不能信任 `ctx.packageDir`**：部署态下框架把它设成了 `botDir`
 * （`resources/app/build/cortico/src/deploy.ts` 里 `pkgDir: string = botDir`），
 * 那是部署目录，里面既没有 `node_modules` 也没有 `dist`，会让自检永远报"缺依赖"。
 *
 * 正确做法：从**当前模块文件**往上走，找到带 `package.json` 且 name 对得上的目录。
 * 传进来的 `fallback` 只在前者找不到时才用。
 */
export function resolvePackageRoot(moduleUrl: string, fallback: string): string {
  const candidates: string[] = [];
  try {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let depth = 0; depth < 4; depth += 1) {
      candidates.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // file URL 解析失败就走 fallback
  }
  candidates.push(fallback);

  for (const candidate of candidates) {
    const pkgFile = join(candidate, 'package.json');
    if (!existsSync(pkgFile)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: string };
      if (pkg?.name === PACKAGE_NAME) return candidate;
    } catch {
      // 坏 JSON 就跳过
    }
  }
  return fallback;
}

export function probeDeps(packageDir: string, installing = false): DepsStatus {
  const resolved = findDepsDir(packageDir, runtimeDeps());
  const hasNodeModules = resolved.dir !== null;
  const missing: string[] = [];

  if (!hasNodeModules) {
    missing.push(
      resolved.missing.length
        ? `${resolved.missing.join('、')}（本包目录和上层 node_modules 都没有）`
        : '依赖目录',
    );
  }

  const hasDist = existsSync(join(packageDir, 'dist', 'webui.js'));
  const manager = resolvePackageManager();
  return {
    node: process.version,
    hasNodeModules,
    missing,
    hasDist,
    ready: hasNodeModules && hasDist,
    installing,
    ...(manager ? { manager: manager.label } : { managerProblem: '找不到可用的包管理器：请安装 Node.js 20+ 后再点一键安装' }),
  };
}

export interface InstallProgress {
  running: boolean;
  finished: boolean;
  ok: boolean;
  /** 当前阶段：install / build / done。 */
  phase: 'idle' | 'install' | 'build' | 'done';
  /** 最近若干行输出（给面板滚着看）。 */
  lines: string[];
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

const MAX_LINES = 200;

export class DepsInstaller {
  private progress: InstallProgress = { running: false, finished: false, ok: false, phase: 'idle', lines: [] };
  private child: ReturnType<typeof spawn> | null = null;

  constructor(private readonly packageDir: string) {}

  status(): InstallProgress {
    return { ...this.progress, lines: [...this.progress.lines] };
  }

  isRunning(): boolean {
    return this.progress.running;
  }

  /**
   * 开始安装。已有一个在跑时直接返回 false（不并发）。
   * 顺序：`npm install` → `npm run build:webui`。
   */
  start(): boolean {
    if (this.progress.running) return false;
    this.progress = {
      running: true,
      finished: false,
      ok: false,
      phase: 'install',
      lines: [],
      startedAt: Date.now(),
    };
    void this.run();
    return true;
  }

  stop(): void {
    try {
      this.child?.kill();
    } catch {
      // 已经退了
    }
  }

  private push(line: string): void {
    const text = line.trimEnd();
    if (!text) return;
    this.progress.lines.push(text);
    if (this.progress.lines.length > MAX_LINES) this.progress.lines.splice(0, this.progress.lines.length - MAX_LINES);
  }

  private async run(): Promise<void> {
    const distReady = existsSync(join(this.packageDir, 'dist', 'webui.js'));
    try {
      try {
        await this.exec(this.installArgs(distReady), 'install', this.packageDir);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // 市场装的包可能落在包管理器的只读目录里：改在上层 node_modules 装（Node 会向上找）
        if (/EACCES|EPERM|permission|denied|EROFS/i.test(reason)) {
          const parent = dirname(this.packageDir);
          this.push(`本包目录不可写，改在 ${parent} 安装（Node 会向上查找依赖）`);
          await this.exec(this.installArgs(distReady), 'install', parent);
        } else {
          throw error;
        }
      }

      this.progress.phase = 'build';
      if (existsSync(join(this.packageDir, 'dist', 'webui.js'))) {
        // 市场包自带面板产物，不用重建（也避免在只读目录里写文件）
        this.push('面板产物已随包提供，跳过构建');
      } else {
        await this.exec(['run', 'build:webui'], 'build', this.packageDir);
      }

      this.progress.phase = 'done';
      this.progress.ok = true;
      this.progress.finished = true;
      this.progress.running = false;
      this.progress.endedAt = Date.now();
      this.push('✅ 依赖已装好。请重启 Coo 进程（不是只重启 World），再回来登录。');
    } catch (error) {
      this.progress.ok = false;
      this.progress.finished = true;
      this.progress.running = false;
      this.progress.phase = 'done';
      this.progress.endedAt = Date.now();
      this.progress.error = error instanceof Error ? error.message : String(error);
      this.push(`❌ 安装失败：${this.progress.error}`);
    } finally {
      this.child = null;
    }
  }

  /**
   * 按安装器拼参数：--no-audit/--no-fund 是 npm 专属，pnpm 直接报 Unknown options；
   * pnpm 跳过 devDependencies 用 --prod，npm 用 --omit=dev。
   * 面板产物已在包里时只装运行依赖（esbuild 那些不需要）。
   */
  private installArgs(prodOnly: boolean): string[] {
    const manager = resolvePackageManager();
    const args = ['install'];
    if (!manager || manager.kind === 'npm') {
      args.push('--no-audit', '--no-fund');
      if (prodOnly) args.push('--omit=dev');
      return args;
    }
    if (prodOnly) args.push('--prod');
    return args;
  }

  /** 跑一个安装/构建子命令，把输出流进缓冲。 */
  private exec(args: string[], phase: 'install' | 'build', cwd = this.packageDir): Promise<void> {
    return new Promise((resolve, reject) => {
      const manager = resolvePackageManager();
      if (!manager) {
        reject(new Error(
          '这台机器上没有可用的包管理器（Coo 自带 pnpm 没找到，系统也没有 pnpm/npm）。'
          + '请先安装 Node.js 20+（https://nodejs.org），再点一次「一键安装依赖」。',
        ));
        return;
      }
      const command = [...manager.baseArgs, ...args];
      const prodOnly = args.includes('--prod') || args.includes('--omit=dev');
      this.push(`$ ${manager.label} ${args.join(' ')}`);
      let child;
      try {
        child = spawn(manager.command, command, {
          cwd,
          shell: process.platform === 'win32' && manager.kind !== 'bundled-pnpm',
          env: {
            ...process.env,
            ...manager.env,
            npm_config_loglevel: 'warn',
            // 只在"确实只要运行依赖"时才压 NODE_ENV；
            // 开发目录要装 devDependencies（esbuild 等），否则构建那步会缺依赖
            ...(prodOnly ? { NODE_ENV: 'production', npm_config_production: 'true' } : {}),
          },
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;
      child.stdout?.on('data', (chunk: Buffer) => this.push(chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => this.push(chunk.toString()));
      child.on('error', (error) => reject(new Error(`依赖安装启动失败：${error.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${manager.label} ${args.join(' ')} 退出码 ${code}`));
      });
    });
  }
}

// ---------------------------------------------------------------------------
// 包管理器探测：优先用 Coo 自带的 pnpm，实在没有才回落到系统 npm
// ---------------------------------------------------------------------------

export type ManagerKind = 'bundled-pnpm' | 'pnpm' | 'npm';

export interface PackageManager {
  kind: ManagerKind;
  /** 可执行文件（bundled-pnpm 是宿主 exe，靠 ELECTRON_RUN_AS_NODE 当 node 用）。 */
  command: string;
  /** 命令前缀：bundled-pnpm 需要先跟 pnpm.cjs 路径。 */
  baseArgs: string[];
  /** 额外环境变量。 */
  env: Record<string, string>;
  /** 给用户看的名字。 */
  label: string;
}

/** Coo 里 pnpm 的常见位置（Win/Linux 与 macOS 布局不同）。 */
export function bundledPnpmCandidates(execPath = process.execPath): string[] {
  const roots: string[] = [];
  const exeDir = dirname(execPath);
  roots.push(join(exeDir, 'resources', 'app'));
  roots.push(join(exeDir, '..', 'Resources', 'app')); // macOS: Foo.app/Contents/MacOS → ../Resources
  roots.push(join(exeDir, '..', 'resources', 'app'));
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath) roots.push(join(resourcesPath, 'app'));

  return roots.map((root) => join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'));
}

/** 找系统 PATH 里的某个可执行文件（不做 shell 调用，纯文件判断 + PATH 扫描）。 */
function findOnPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, `${name}${ext}`);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * 挑一个包管理器。顺序：
 *  1. Coo 自带 pnpm（用户零前置，最省事）
 *  2. 系统 pnpm
 *  3. 系统 npm（老逻辑，兜底）
 * 都没有 → null（面板会提示"请先装 Node 20+"，而不是抛 ENOENT）。
 */
export function resolvePackageManager(execPath = process.execPath): PackageManager | null {
  for (const candidate of bundledPnpmCandidates(execPath)) {
    if (existsSync(candidate)) {
      return {
        kind: 'bundled-pnpm',
        command: execPath,
        baseArgs: [candidate],
        // Electron 支持：把宿主可执行文件当 node 用
        env: { ELECTRON_RUN_AS_NODE: '1' },
        label: 'Coo 自带 pnpm',
      };
    }
  }

  const pnpm = findOnPath(process.platform === 'win32' ? 'pnpm' : 'pnpm');
  if (pnpm) return { kind: 'pnpm', command: pnpm, baseArgs: [], env: {}, label: '系统 pnpm' };

  const npm = findOnPath(process.platform === 'win32' ? 'npm' : 'npm');
  if (npm) return { kind: 'npm', command: npm, baseArgs: [], env: {}, label: '系统 npm' };

  return null;
}