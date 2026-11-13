/**
 * 契约测试：不联网、不需要账号。
 * 验证 World 能被构造，工具/面板/事件声明齐全，且满足框架的形状要求。
 * 跑法：npx tsx tests/contract.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TELEGRAM } from '../src/definition.ts';

const ctx = {
  id: 'telegram',
  cfg: TELEGRAM.defaults() as any,
  timezone: 'Asia/Shanghai',
  botName: 'probe',
  botDir: process.cwd(),
  packageDir: process.cwd(),
  dataDir: process.env.TEMP ?? '.',
  repoRoot: process.cwd(),
  secret: () => '',
  storeSecret: () => {},
  persist: () => {},
  restart: async () => {},
};

const world = TELEGRAM.create(ctx as any);
const ui = world.webUi?.('zh');
const tools = world.tools();

const lines = [
  `id=${TELEGRAM.id} label=${TELEGRAM.label}`,
  `defaults keys=${Object.keys(TELEGRAM.defaults()).length}`,
  `tools=${tools.map((t) => t.name).join(',')}`,
  `tool tags=${tools.map((t) => `${t.name}:${t.tags.join('+')}`).join(',')}`,
  `params ok=${tools.every((t) => (t.parameters as any)?.type === 'object')}`,
  `panels=${(ui?.panels ?? []).map((p) => p.id).join(',')}`,
  `lamps=${(ui?.lamps ?? []).map((l) => `${l.label}:${l.state}`).join(',')}`,
  `promptDocs=${(ui?.promptDocs ?? []).length} storage=${(ui?.storage ?? []).length}`,
  `events=${(TELEGRAM.describe?.events ?? []).map((e) => e.type).join(',')}`,
  `describe tools=${(TELEGRAM.describe?.tools ?? []).length}`,
  `envPromptVars keys=${Object.keys((await world.envPromptVars()) ?? {}).length}`,
];

console.log(lines.join('\n'));

const names = tools.map((t) => t.name);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
if (dup.length) throw new Error(`工具重名：${dup.join(',')}`);
if (!tools.every((t) => (t.parameters as any)?.type === 'object')) throw new Error('工具参数必须是 object schema');
if (!tools.every((t) => t.tags.length > 0)) throw new Error('每个工具都要有 tag');
if (!ui?.invoke) throw new Error('缺少面板 invoke');
if (!ui.storage?.length) throw new Error('缺少 storage 声明');

// 面板声明必须齐全：少一个，页面上就是没有这个页签（上一轮就是这么丢的「媒体目录」）
const panelIds = (ui?.panels ?? []).map((panel) => panel.id);
for (const expected of ['login', 'chats', 'resources', 'stickers', 'behavior', 'status']) {
  if (!panelIds.includes(expected)) throw new Error(`缺少面板声明：${expected}（当前：${panelIds.join(',')}）`);
}
if (!TELEGRAM.describe?.tools.length) throw new Error('缺少自描述');

// 自描述与实例工具表必须对得上（tools() 可以是子集，但名字不能凭空出现）
const declared = new Set((TELEGRAM.describe?.tools ?? []).map((t) => t.name));
for (const name of names) {
  if (!declared.has(name)) throw new Error(`工具 ${name} 未在 describe 里声明`);
}

// 模板变量与声明的强一致性：
// 1) 模板里用到的每个 {{占位符}} 都必须在 promptDocs.vars 里声明——否则编辑器会原样保留、不替换；
// 2) 声明的每个变量都必须真的由 envPromptVars() 提供值。
{
  const promptPath = fileURLToPath(new URL('../src/prompt/ENV_PROMPT.md', import.meta.url));
  const template = readFileSync(promptPath, 'utf8');
  const used = new Set([...template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!));
  const declared = new Set((ui?.promptDocs?.[0] as { vars?: Array<{ name: string }> } | undefined)?.vars?.map((v) => v.name) ?? []);
  const provided = new Set(Object.keys((await world.envPromptVars()) ?? {}));

  const undeclared = [...used].filter((name) => !declared.has(name));
  const unprovided = [...declared].filter((name) => !provided.has(name));
  if (undeclared.length) throw new Error(`模板用了但没声明（会被原样保留）：${undeclared.join(', ')}`);
  if (unprovided.length) throw new Error(`声明了但 envPromptVars 没给值：${unprovided.join(', ')}`);
  console.log(`template vars ok: ${used.size} 个占位符全部声明且有值`);
}

console.log('\nCONTRACT OK');
