/**
 * 语音条转换。
 *
 * Telegram 的 voice message 只认 ogg/opus（单声道、opus 编码）。Coopanion 侧的 TTS
 * （gpt-sovits / RVC）通常产出 wav，直接发只会变成「音频文件」，不是语音条。
 * 所以这里用本机 ffmpeg 转一道；ffmpeg 不在时如实报错，不假装已转换。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ALREADY_OGG = /\.(ogg|opus)$/i;

export interface VoiceConvertResult {
  /** 可以直接发送的文件路径。 */
  path: string;
  /** 是否真的转过码。 */
  converted: boolean;
  /** 给人看的说明（回执里带上）。 */
  note?: string;
}

export interface VoiceConvertOptions {
  /** ffmpeg 可执行文件，默认 `ffmpeg`（走 PATH）。 */
  ffmpegPath?: string;
  /** 转码产物放在哪，默认与源文件同目录。 */
  outDir?: string;
  /** 码率，默认 48 kbps——语音条够用且体积小。 */
  bitrateKbps?: number;
  /** 单次转码超时，默认 120 秒。 */
  timeoutMs?: number;
}

export class FfmpegMissingError extends Error {
  constructor() {
    super('本机没有可用的 ffmpeg，无法把音频转成语音条（ogg/opus）；可以在配置里填写 ffmpegPath，或先自行转成 .ogg');
    this.name = 'FfmpegMissingError';
  }
}

/** ffmpeg 是否可用（带缓存，避免每次都 spawn）。 */
const availability = new Map<string, boolean>();

export async function ffmpegAvailable(ffmpegPath = 'ffmpeg'): Promise<boolean> {
  const cached = availability.get(ffmpegPath);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    await run(ffmpegPath, ['-version'], { timeout: 10_000, windowsHide: true });
    ok = true;
  } catch {
    ok = false;
  }
  availability.set(ffmpegPath, ok);
  return ok;
}

/**
 * 保证返回一个 ogg/opus 文件。
 * - 已经是 ogg/opus：原样返回
 * - 其他格式：调 ffmpeg 转码（`-application voip` 让 Telegram 认成语音）
 */
export async function ensureVoiceOgg(inputPath: string, opts: VoiceConvertOptions = {}): Promise<VoiceConvertResult> {
  if (!existsSync(inputPath)) throw new Error(`文件不存在：${inputPath}`);
  if (ALREADY_OGG.test(inputPath)) return { path: inputPath, converted: false };

  const ffmpegPath = opts.ffmpegPath?.trim() || 'ffmpeg';
  if (!(await ffmpegAvailable(ffmpegPath))) throw new FfmpegMissingError();

  const outDir = opts.outDir ?? join(inputPath, '..');
  mkdirSync(outDir, { recursive: true });
  const stem = basename(inputPath, extname(inputPath)).replace(/[^\w.-]+/g, '_');
  const out = join(outDir, `${stem}-voice-${Date.now()}.ogg`);

  const args = [
    '-y',
    '-i', inputPath,
    '-vn',
    '-c:a', 'libopus',
    '-b:a', `${opts.bitrateKbps ?? 48}k`,
    '-ar', '48000',
    '-ac', '1',
    '-application', 'voip',
    out,
  ];

  try {
    await run(ffmpegPath, args, { timeout: opts.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const tail = stderr.trim().split('\n').slice(-3).join(' | ');
    throw new Error(`ffmpeg 转码失败${tail ? `：${tail}` : `：${(error as Error).message}`}`);
  }

  if (!existsSync(out) || statSync(out).size === 0) throw new Error('ffmpeg 跑完了但没产出文件');
  return { path: out, converted: true, note: `已转码为语音条（opus ${opts.bitrateKbps ?? 48}kbps）` };
}
