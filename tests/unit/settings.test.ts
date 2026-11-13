/**
 * 行为设置页的字段表 / 校验 / 取值单测。
 * 跑法：npx tsx tests/unit/settings.test.ts
 */

import { telegramDefaults } from '../../src/config.ts';
import { applyBehaviorPatch, behaviorFields, behaviorValues } from '../../src/settings.ts';

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

const cfg = telegramDefaults();

console.log('\n# 字段表');
{
  const fields = behaviorFields(true);
  ok('有字段', fields.length > 10);
  ok('每个字段有 key/group/label', fields.every((f) => f.key && f.group && f.label));
  ok('包含 3 个 guard 字段', fields.filter((f) => f.key.startsWith('guard.')).length === 3);
  ok('enum 都有选项', fields.filter((f) => f.type === 'enum').every((f) => (f.options ?? []).length > 0));
  ok('int 都有范围', fields.filter((f) => f.type === 'int').every((f) => f.min !== undefined && f.max !== undefined));
  ok('key 不重复', new Set(fields.map((f) => f.key)).size === fields.length);
}

console.log('\n# 取值');
{
  const values = behaviorValues(cfg, true);
  eq('默认 watchSelf', values.watchSelf, cfg.watchSelf);
  eq('默认 guard 删除', values['guard.deleteRevoke'], 'auto');
  ok('取值覆盖所有字段', Object.keys(values).length === behaviorFields(true).length);
}

console.log('\n# 单位换算（MB ↔ 字节）');
{
  const values = behaviorValues(cfg, true);
  eq('默认显示 8 MB', values.maxMediaBytes, 8);
  const patch = applyBehaviorPatch({ maxMediaBytes: 20 }, true);
  eq('20 MB 存成字节', patch.config.maxMediaBytes, 20 * 1024 * 1024);
  const tooBig = applyBehaviorPatch({ maxMediaBytes: 999 }, true);
  eq('超上限夹到 100 MB', tooBig.config.maxMediaBytes, 100 * 1024 * 1024);
  const tooSmall = applyBehaviorPatch({ maxMediaBytes: 0 }, true);
  eq('低于下限夹到 1 MB', tooSmall.config.maxMediaBytes, 1024 * 1024);
  ok('提示里写的是 MB', String(patch.changed.join()).includes('MB'));
}

console.log('\n# 校验与规整');
{
  const out = applyBehaviorPatch({ watchSelf: 'echo', mergeWindowMs: 5000, 'guard.blockUser': 'ask' }, true);
  eq('普通字段进 config', out.config.watchSelf, 'echo');
  eq('数字字段', out.config.mergeWindowMs, 5000);
  eq('guard 单独收集', out.guard.blockUser, 'ask');
  eq('改动清单条数', out.changed.length, 3);

  const clamped = applyBehaviorPatch({ mergeWindowMs: 999999 }, true);
  eq('超上限被夹住', clamped.config.mergeWindowMs, 15000);
  const clampedLow = applyBehaviorPatch({ mergeWindowMs: -50 }, true);
  eq('低于下限被夹住', clampedLow.config.mergeWindowMs, 0);

  let threw = false;
  try {
    applyBehaviorPatch({ watchSelf: 'nonsense' }, true);
  } catch {
    threw = true;
  }
  ok('非法枚举抛错', threw);

  let threwInt = false;
  try {
    applyBehaviorPatch({ mergeWindowMs: 'abc' }, true);
  } catch {
    threwInt = true;
  }
  ok('非法数字抛错', threwInt);

  const unknown = applyBehaviorPatch({ hackThePlanet: true }, true);
  eq('未知键被忽略', Object.keys(unknown.config).length, 0);
  eq('忽略后没有改动', unknown.changed, []);

  const bool = applyBehaviorPatch({ autoImages: false }, true);
  eq('布尔字段', bool.config.autoImages, false);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
