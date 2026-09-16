/**
 * DB Client → environment variables.
 *
 *   naming.ts    the two shapes, and the driver words that are not framework words
 *   detect.ts    what the project already calls it, which wins over both
 *   diff.ts      the preview, because this edits someone's own file
 *   service.ts   detect, preview, apply, undo
 */

export type { EnvScope } from './service';
export { dbClientEnv } from './service';
export type { EnvNaming, EnvRenderInput } from './naming';
export { defaultPrefixFor, keyFor, renderEnvVars, shapeInfos } from './naming';
export { detectEnvUsage } from './detect';
export { diffLines } from './diff';
