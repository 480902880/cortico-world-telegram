/**
 * 构建浏览器侧面板产物。
 *
 * Cortico 要求扩展提供 `cortico.webUiClient` 指向的已构建 ESM 文件，缺了就报
 * 「缺少面板构建产物」。框架对内置 World 用 `pnpm build:web` 统一打包；外部扩展
 * 由**包自己**构建（错误文案原话：extensions/ 下的扩展请在包目录构建）。
 *
 * 只打 `src/webui/client.ts` 一个入口：
 *  - `format: esm`，与框架 `scripts/build-web.ts` 的产出一致
 *  - `platform: browser`
 *  - `import type` 被擦除，所以产物里没有任何 `cortico/*` 运行时依赖
 */

import * as esbuild from 'esbuild';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintFiles, webuiSourceFiles, writeMeta } from './freshness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outfile = resolve(root, 'dist/webui.js');

mkdirSync(dirname(outfile), { recursive: true });

const result = await esbuild.build({
  entryPoints: [resolve(root, 'src/webui/client.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  // 框架运行时模块只用于 import type，不该出现在产物里；显式 external 是双保险。
  external: ['cortico', 'cortico/*'],
  metafile: true,
  logLevel: 'warning',
});

const inputs = Object.keys(result.metafile.inputs);
const size = statSync(outfile).size;

// P-01：记下输入源码的指纹，打包时用来判断产物是不是旧的
const meta = writeMeta(root, {
  writeFile: writeFileSync,
  sourceHash: fingerprintFiles(root, webuiSourceFiles(root)),
  outFile: outfile,
});
console.log(`  meta   dist/webui.meta.json（sourceHash ${meta.sourceHash}）`);

console.log(`built ${outfile}`);
console.log(`  size   ${(size / 1024).toFixed(1)} KiB`);
console.log(`  inputs ${inputs.length} 个文件`);
for (const input of inputs.slice(0, 8)) console.log(`    ${input}`);
if (inputs.length > 8) console.log(`    … 另有 ${inputs.length - 8} 个`);
