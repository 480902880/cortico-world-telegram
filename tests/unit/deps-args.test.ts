/**
 * 安装参数要跟安装器匹配（pnpm 不认 npm 的 --no-audit / --no-fund）。
 * 跑法：npx tsx tests/unit/deps-args.test.ts
 *
 * 真实事故：面板点「一键安装依赖」→ 走 Coo 自带 pnpm → 传了 npm 的参数
 * → `[ERROR] Unknown options: 'audit', 'fund'`，安装直接失败。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** 直接读源码断言参数拼装逻辑（避免为了测试注入一堆依赖）。 */
const source = readFileSync(join(process.cwd(), 'src/deps.ts'), 'utf8');

console.log('\n# npm 专属参数只会给 npm');
{
  // npm 分支：--no-audit / --no-fund 必须出现在 npm 判断里面
  const npmBranch = source.slice(
    source.indexOf("if (!manager || manager.kind === 'npm')"),
    source.indexOf("if (prodOnly) args.push('--prod')"),
  );
  ok('npm 分支存在', npmBranch.length > 0);
  ok('npm 分支带 --no-audit', npmBranch.includes("'--no-audit'"));
  ok('npm 分支带 --no-fund', npmBranch.includes("'--no-fund'"));
  ok('npm 分支用 --omit=dev 跳 devDependencies', npmBranch.includes("'--omit=dev'"));

  // pnpm 分支（npm 判断之后到方法结束）不能出现 npm 专属参数
  const pnpmBranch = source.slice(
    source.indexOf("if (prodOnly) args.push('--prod')"),
    source.indexOf('private exec('),
  );
  ok('pnpm 分支存在', pnpmBranch.length > 0);
  ok('pnpm 分支不带 --no-audit', !pnpmBranch.includes('--no-audit'));
  ok('pnpm 分支不带 --no-fund', !pnpmBranch.includes('--no-fund'));
  ok('pnpm 用 --prod 跳 devDependencies', pnpmBranch.includes("'--prod'"));
}

console.log('\n# 只有"只要运行依赖"时才压生产环境');
{
  ok('prodOnly 由参数决定', source.includes("args.includes('--prod') || args.includes('--omit=dev')"));
  ok('NODE_ENV 受 prodOnly 控制', /prodOnly \? \{ NODE_ENV: 'production'/.test(source));
}

console.log('\n# 面板产物已在包里时不再装 devDependencies');
{
  ok('先判断 dist 是否存在', source.includes("existsSync(join(this.packageDir, 'dist', 'webui.js'))"));
  ok('按 distReady 选择参数', source.includes('this.installArgs(distReady)'));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
