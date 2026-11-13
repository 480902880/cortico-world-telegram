/**
 * 语音条转码测试：真的调 ffmpeg。
 * 没有 ffmpeg 时整体跳过（不判失败），因为那是环境问题不是代码问题。
 * 跑法：npx tsx tests/unit/voice.test.ts
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ensureVoiceOgg, ffmpegAvailable, FfmpegMissingError } from '../../src/media/voice.ts';

const run = promisify(execFile);
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

const dir = mkdtempSync(join(tmpdir(), 'tg-voice-'));

async function main(): Promise<void> {
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) {
    console.log('SKIP：本机没有 ffmpeg，语音转码测试跳过');
    return;
  }
  console.log('\n# 生成测试音频（ffmpeg 合成 1 秒正弦波 wav）');
  const wav = join(dir, 'tone.wav');
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav], { windowsHide: true });
  ok('wav 已生成', existsSync(wav) && statSync(wav).size > 1000);

  console.log('\n# 转码成语音条');
  const result = await ensureVoiceOgg(wav, { outDir: dir });
  ok('标记为已转码', result.converted === true);
  ok('产物存在', existsSync(result.path));
  ok('扩展名是 .ogg', result.path.endsWith('.ogg'), result.path);
  const head = readFileSync(result.path).subarray(0, 4).toString('latin1');
  ok('真的是 Ogg 容器', head === 'OggS', head);
  ok('体积合理（>1KB）', statSync(result.path).size > 1024, String(statSync(result.path).size));
  ok('回执带说明', typeof result.note === 'string' && result.note.includes('opus'));

  console.log('\n# 已经是 ogg 的不重复转码');
  const again = await ensureVoiceOgg(result.path, { outDir: dir });
  ok('原样返回', again.path === result.path && again.converted === false);

  console.log('\n# 文件不存在');
  let threw = false;
  try {
    await ensureVoiceOgg(join(dir, 'nope.wav'), { outDir: dir });
  } catch {
    threw = true;
  }
  ok('报错而不是静默', threw);

  console.log('\n# ffmpeg 路径不存在');
  let missing = false;
  try {
    await ensureVoiceOgg(wav, { outDir: dir, ffmpegPath: 'definitely-not-ffmpeg-xyz' });
  } catch (error) {
    missing = error instanceof FfmpegMissingError;
  }
  ok('抛 FfmpegMissingError', missing);
}

try {
  await main();
} finally {
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}
