/**
 * 市场发布自检：包元数据是否满足上架条件。
 * 跑法：npx tsx tests/market.ts
 *
 * 这里不重复框架 `pnpm check:extension` 的 manifest 校验（那需要 Cortico 仓库），
 * 只守住**打包就会踩到的坑**：
 *  - 面板产物 dist/webui.js 必须在包里，否则市场用户装上去看不到任何页面
 *  - describe.json 必须随包（check:extension 要求有）
 *  - keywords 必须含 cortico-world，否则市场按类发现不到
 *  - tags 必须来自官方标签表（本地留一份副本，避免打错字）
 *  - screenshots / icon 指向的文件真的存在
 *  - files 白名单要覆盖这些产物
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, any>;

let failed = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const cortico = pkg.cortico ?? {};

console.log('\n# 清单');
check('kind = world', cortico.kind === 'world');
check('api = 6（World 契约版本）', cortico.api === 6, String(cortico.api));
check('type = module', pkg.type === 'module');
check('有 license', typeof pkg.license === 'string' && pkg.license.length > 0);
check('有 author', Boolean(pkg.author));
check('有 engines.node', Boolean(pkg.engines?.node));

console.log('\n# 市场发现');
const keywords: string[] = pkg.keywords ?? [];
check('keywords 含 cortico-world', keywords.includes('cortico-world'), keywords.join(','));
check('tags 是字符串数组', Array.isArray(cortico.tags) && cortico.tags.every((t: unknown) => typeof t === 'string'));
const KNOWN_TAGS = new Set([
  'pal-ai-world', 'corti', 'coopanion', 'im', 'qq', 'streaming', 'game', 'internet', 'browser',
  'video', 'voice', 'computer-use', 'real-world', 'apps', 'memory', 'companion', 'creative',
  'diagnostics', 'local', 'external-setup', 'requires-key', 'experimental', 'internal-state',
  'requires-extension', 'high-cost', 'unofficial-api', 'unsafe', 'sensitive-data',
  'injection-risk',
]);
const unknownTags = (cortico.tags ?? []).filter((t: string) => !KNOWN_TAGS.has(t));
check('tags 都在官方标签表里', unknownTags.length === 0, unknownTags.join(','));
check('声明了 im（这是 IM 平台扩展）', (cortico.tags ?? []).includes('im'));

console.log('\n# 产物');
for (const file of ['dist/webui.js', 'describe.json']) {
  check(`${file} 存在`, existsSync(join(root, file)));
}
check('webUiClient 指向 dist/webui.js', cortico.webUiClient === './dist/webui.js');
check('describe 指向 describe.json', cortico.describe === './describe.json');
check('icon 文件存在', typeof cortico.icon === 'string' && existsSync(join(root, cortico.icon)));
const shots: string[] = cortico.screenshots ?? [];
check('至少一张截图', shots.length > 0);
for (const shot of shots) check(`截图存在：${shot}`, existsSync(join(root, shot)));

console.log('\n# files 白名单覆盖必需产物');
const files: string[] = pkg.files ?? [];
const mustShip = ['dist', 'src', 'describe.json', 'README.md', 'LICENSE'];
for (const need of mustShip) {
  check(`files 含 ${need}`, files.some((entry: string) => entry === need || entry.startsWith(`${need}/`)), files.join(','));
}
check('files 不含 node_modules', !files.includes('node_modules'));
check('files 不含 tests', !files.includes('tests'));

if (failed > 0) {
  console.error(`\nMARKET CHECK FAILED：${failed} 项不合格`);
  process.exitCode = 1;
} else {
  console.log('\nMARKET OK');
}
