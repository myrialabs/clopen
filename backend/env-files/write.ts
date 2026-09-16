/**
 * Putting variables into a project's dotenv file.
 *
 * One rule is a hard refusal: **never a file git TRACKS.** For DB Client the
 * cost is committing a live database password; for worktree branching it is
 * worse — "Apply to Main" would carry the branch connection string into the
 * main project, overwriting the real one with a URL pointing at a database that
 * deleting the worktree destroys. Both are refused and reported rather than
 * written and hoped about, and the refusal is overridable only where the caller
 * says so explicitly.
 *
 * Nothing here throws for an ordinary failure. Every caller has already done
 * the expensive, visible thing the user asked for — created a worktree, linked
 * a database — and a variable that did not land is worth a sentence, not an
 * exception that undoes the rest.
 */

import fs from 'fs/promises';
import path from 'path';
import { removeEnvKeys, upsertEnvKeys } from './edit';
import { isSafeEnvFileName } from './keys';
import { isTrackedInGit } from './git';
import { debug } from '$shared/utils/logger';

export type EnvWriteStatus = 'written' | 'unchanged' | 'skipped-tracked' | 'failed';

export interface EnvWriteResult {
	status: EnvWriteStatus;
	/** One sentence, naming what happened and what to do. Null when it worked. */
	detail: string | null;
	fileName: string;
	updated: string[];
	appended: string[];
}

export interface EnvWriteInput {
	root: string;
	fileName: string;
	vars: Record<string, string>;
	/** A comment above the appended lines, naming where they came from. */
	note?: string;
	/** Write even though git tracks the file. The caller must have asked. */
	allowTracked?: boolean;
}

/** The file as it is, or an empty string when it does not exist yet. */
export async function readEnvFile(
	root: string,
	fileName: string
): Promise<{ text: string; exists: boolean }> {
	try {
		return { text: await fs.readFile(path.join(root, fileName), 'utf-8'), exists: true };
	} catch {
		return { text: '', exists: false };
	}
}

export interface EnvWritePlan {
	fileName: string;
	exists: boolean;
	/** The file as it is now. */
	current: string;
	/** The file as it would be. */
	next: string;
	updated: string[];
	appended: string[];
	unchanged: string[];
	/** True when git tracks the target, which refuses the write by default. */
	tracked: boolean;
}

/**
 * Work out the write without performing it.
 *
 * Exists so the panel can show a diff of someone's own configuration file
 * before touching it, and so `writeEnvVars` and the preview can never disagree
 * about what would happen.
 */
export async function planEnvWrite(input: EnvWriteInput): Promise<EnvWritePlan> {
	if (!isSafeEnvFileName(input.fileName)) {
		throw new Error(`"${input.fileName}" is not a dotenv file in the project root.`);
	}

	const [{ text, exists }, tracked] = await Promise.all([
		readEnvFile(input.root, input.fileName),
		isTrackedInGit(input.root, input.fileName)
	]);

	const result = upsertEnvKeys(text, input.vars, { note: input.note });

	return {
		fileName: input.fileName,
		exists,
		current: text,
		next: result.text,
		updated: result.updated,
		appended: result.appended,
		unchanged: result.unchanged,
		tracked
	};
}

export async function writeEnvVars(input: EnvWriteInput): Promise<EnvWriteResult> {
	const empty = { fileName: input.fileName, updated: [], appended: [] };

	let plan: EnvWritePlan;
	try {
		plan = await planEnvWrite(input);
	} catch (error) {
		return { status: 'failed', detail: messageOf(error), ...empty };
	}

	if (plan.tracked && !input.allowTracked) {
		return {
			status: 'skipped-tracked',
			detail: `git tracks ${input.fileName}, so writing a password into it would commit one — add it to .gitignore or pick a file that is ignored.`,
			...empty
		};
	}

	if (plan.next === plan.current && plan.exists) {
		return {
			status: 'unchanged',
			detail: null,
			fileName: input.fileName,
			updated: [],
			appended: []
		};
	}

	try {
		await fs.writeFile(path.join(input.root, input.fileName), plan.next, 'utf-8');
		debug.log('env-files', `Wrote ${plan.updated.length + plan.appended.length} variable(s) into ${input.fileName}`);
		return {
			status: 'written',
			detail: null,
			fileName: input.fileName,
			updated: plan.updated,
			appended: plan.appended
		};
	} catch (error) {
		return { status: 'failed', detail: `Could not write ${input.fileName}: ${messageOf(error)}`, ...empty };
	}
}

/**
 * Take the managed block and every replaced value back out.
 *
 * Silent about a missing file: there is nothing to undo, which is the outcome
 * the caller wanted.
 */
export async function clearEnvVars(input: {
	root: string;
	fileName: string;
	keys: string[];
	/** Remove an appended key only while it still holds this value. */
	values?: Record<string, string>;
}): Promise<{ changed: boolean }> {
	if (!isSafeEnvFileName(input.fileName)) return { changed: false };
	const target = path.join(input.root, input.fileName);
	try {
		const existing = await fs.readFile(target, 'utf-8');
		const next = removeEnvKeys(existing, input.keys, { values: input.values });
		if (next === existing) return { changed: false };
		await fs.writeFile(target, next, 'utf-8');
		return { changed: true };
	} catch {
		// The file is gone, or was never written. Either way there is no block.
		return { changed: false };
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Worktree branching's write, in its own words.
 *
 * IN PLACE, like every other write here. A worktree is a FILE COPY of the
 * project and therefore already carries the project's own `DATABASE_URL` — so
 * an earlier version appended a marked block at the end and relied on readers
 * taking the last assignment. It worked and it read as if it did not: the
 * project's value sat untouched at the top of the file, and anyone opening it
 * saw their own database named first. Replacing the line where it stands says
 * what is true, and the previous value survives as the comment above it.
 *
 * A tracked file is refused outright with no override, because the danger there
 * is not a committed password but "Apply to Main" overwriting the real database
 * URL with a disposable one.
 */
export async function writeWorktreeEnv(input: {
	worktreeRoot: string;
	fileName: string;
	vars: Record<string, string>;
	note?: string;
}): Promise<{ status: 'written' | 'skipped-tracked' | 'failed'; detail: string | null }> {
	const result = await writeEnvVars({
		root: input.worktreeRoot,
		fileName: input.fileName,
		vars: input.vars,
		note: input.note
	});

	if (result.status === 'skipped-tracked') {
		return {
			status: 'skipped-tracked',
			detail: `git tracks ${input.fileName}, so writing to it would carry the branch connection string into the main project — add it to .gitignore or point branching at a file that is ignored.`
		};
	}
	// "Unchanged" means the block already said exactly this, which is a write
	// that succeeded — reporting it as anything else would light up the retry.
	if (result.status === 'unchanged') return { status: 'written', detail: null };
	return { status: result.status, detail: result.detail };
}

/** Put a worktree's dotenv file back the way branching found it. */
export async function clearWorktreeEnv(
	worktreeRoot: string,
	fileName: string,
	vars: Record<string, string> = {}
): Promise<void> {
	await clearEnvVars({
		root: worktreeRoot,
		fileName,
		keys: Object.keys(vars),
		values: vars
	});
}
