/**
 * 包入口：Cortico 取 `default` 并用 `isWorldDefinition()` 校验。
 * 入口路径来自 package.json 的 `exports` → `./src/index.ts`。
 */

import { TELEGRAM } from './definition.ts';

export default TELEGRAM;
export { TELEGRAM };
export type { TelegramConfigSection } from './config.ts';
