/**
 * Dotenv files — the shared primitive.
 *
 * Two features write a connection string into a project's environment, and
 * both go through here:
 *
 *   keys.ts        safe file names, valid variable names, one rendered line
 *   parse.ts       a reader that remembers where every assignment lives
 *   edit.ts        in-place replacement, plain appends, and the undo
 *   discovery.ts   which dotenv files a project has, most-precedent first
 *   git.ts         the one question that can refuse a write
 *   write.ts       the write itself, and the plan the panel previews
 */

export {
	envFilePrecedence,
	formatEnvLine,
	isDotenvFileName,
	isSafeEnvFileName,
	isTemplateEnvFile,
	isValidEnvKey,
	TEMPLATE_SUFFIXES
} from './keys';

export type { DotenvAssignment } from './parse';
export { effectiveAssignment, parseDotenv } from './parse';

export type { EnvUpsertOptions, EnvUpsertResult } from './edit';
export { PREVIOUS_VALUE_PREFIX, removeEnvKeys, upsertEnvKeys } from './edit';

export type { DotenvFileEntry } from './discovery';
export { listDotenvFiles, listEnvFileEntries } from './discovery';

export { isTrackedInGit } from './git';

export type { EnvWriteInput, EnvWritePlan, EnvWriteResult, EnvWriteStatus } from './write';
export {
	clearEnvVars,
	clearWorktreeEnv,
	planEnvWrite,
	readEnvFile,
	writeEnvVars,
	writeWorktreeEnv
} from './write';
