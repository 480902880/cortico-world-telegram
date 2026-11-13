/** 类型声明：freshness.mjs 是零依赖脚本，给 TS 侧（测试）用。 */

export interface FreshnessMeta {
  sourceHash: string;
  builtAt: string;
  inputs: number;
  out: string;
  outSize: number;
}

export type CheckResult = { ok: true; meta?: FreshnessMeta } | { ok: false; reason: string };

export declare function listFiles(dir: string, filter?: (file: string) => boolean): string[];
export declare function fingerprintFiles(root: string, files: string[]): string;
export declare function webuiSourceFiles(root: string): string[];
export declare function describeSourceFiles(root: string): string[];
export declare function metaPath(root: string): string;
export declare function writeMeta(
  root: string,
  opts: { writeFile: (...args: any[]) => void; sourceHash: string; outFile: string },
): FreshnessMeta;
export declare function checkWebuiFreshness(root: string): CheckResult;
export declare function checkDescribeFreshness(root: string): CheckResult;
