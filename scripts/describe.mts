/**
 * 从 definition 生成 describe.json，避免手写漂移。
 * 跑法：npm run describe
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TELEGRAM } from '../src/definition.ts';

const out = {
  id: TELEGRAM.id,
  label: TELEGRAM.label,
  tools: TELEGRAM.describe?.tools ?? [],
  events: TELEGRAM.describe?.events ?? [],
};

const path = join(process.cwd(), 'describe.json');
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`describe.json 已生成：${out.tools.length} 个工具 / ${out.events.length} 个事件`);
for (const tool of out.tools) console.log(`  - ${tool.name} [${tool.tags.join('+')}]`);
