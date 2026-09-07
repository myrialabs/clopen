/**
 * Budgeted staged-diff builder for the AI generators.
 *
 * The commit-message and branch-name handlers used to inline the raw output of
 * `git diff --cached` into the prompt. That has no upper bound: a lockfile
 * refresh or a vendored bundle turns one "generate commit message" click into
 * hundreds of thousands of tokens, and on strict-context models it fails
 * outright instead of degrading.
 *
 * This builds the same information under a hard budget: the `--stat` header
 * always survives (it is small and describes the *whole* change), noisy paths
 * are skipped by name, and the patch body is filled file by file until the
 * budget runs out. Truncation is announced in the text so the model knows it is
 * looking at a sample rather than the complete change.
 */

import { execGit } from '../../git/git-executor';
import { assertSafeGitPathOperand } from '../../git/git-spawn-validation';

export interface DiffBudget {
	/** Max bytes of patch text kept for any single file. */
	perFileBytes: number;
	/** Max bytes of patch text across all files. */
	totalBytes: number;
	/** Max number of files we spawn a `git diff` for. */
	maxFiles: number;
	/** Lines of surrounding context per hunk. */
	contextLines: number;
}

/**
 * Budget for commit messages. Big enough that a normal feature change arrives
 * whole, small enough that a lockfile-sized diff cannot blow up the request.
 */
export const COMMIT_MESSAGE_BUDGET: DiffBudget = {
	perFileBytes: 6 * 1024,
	totalBytes: 24 * 1024,
	maxFiles: 40,
	contextLines: 3
};

/**
 * Budget for branch names. A branch name is one to three words about the *topic*
 * of the change, so the file list carries almost all the signal and the patch is
 * only there to disambiguate.
 */
export const BRANCH_NAME_BUDGET: DiffBudget = {
	perFileBytes: 2 * 1024,
	totalBytes: 4 * 1024,
	maxFiles: 15,
	contextLines: 0
};

/**
 * Paths whose diff is machine-generated: enormous, uninformative, and the single
 * biggest source of wasted context. They still appear in the `--stat` header, so
 * the model can see they changed.
 */
const GENERATED_PATH_PATTERNS: RegExp[] = [
	/(^|\/)(bun\.lock|bun\.lockb|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
	/(^|\/)(Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/,
	/(^|\/)(dist|build|out|vendor|node_modules|coverage)\//,
	/\.(min\.js|min\.css|map|snap)$/,
	/(^|\/)__snapshots__\//
];

function isGeneratedPath(filePath: string): boolean {
	return GENERATED_PATH_PATTERNS.some(pattern => pattern.test(filePath));
}

interface NumstatEntry {
	path: string;
	isBinary: boolean;
}

/**
 * `git diff --cached --numstat -z` emits `adds\tdels\tpath\0`, with `-` counts
 * for binary files. Renames add two extra NUL-separated path fields after an
 * empty path slot, which is why the parser advances through the stream rather
 * than splitting it into fixed records.
 */
function parseNumstat(output: string): NumstatEntry[] {
	const entries: NumstatEntry[] = [];
	const fields = output.split('\0');

	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field.trim()) continue;
		const parts = field.split('\t');
		if (parts.length < 3) continue;

		const [adds, dels, rawPath] = parts;
		let filePath = rawPath;
		if (filePath === '') {
			// Rename/copy: the old and new paths follow as their own fields.
			const newPath = fields[i + 2];
			if (newPath) filePath = newPath;
			i += 2;
		}
		if (!filePath) continue;

		entries.push({ path: filePath, isBinary: adds === '-' && dels === '-' });
	}

	return entries;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const clipped = text.slice(0, limit);
	// Cut on a line boundary so the model never sees half a diff line.
	const lastNewline = clipped.lastIndexOf('\n');
	const body = lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped;
	const droppedLines = text.slice(body.length).split('\n').length;
	return {
		text: `${body}\n… truncated, ${droppedLines} more line${droppedLines === 1 ? '' : 's'} in this file`,
		truncated: true
	};
}

export interface BudgetedDiff {
	/** The rendered prompt section, ready to append. */
	text: string;
	/** True when any file's patch was clipped or dropped. */
	truncated: boolean;
	/** True when there is nothing staged at all. */
	isEmpty: boolean;
}

/**
 * Build the staged-diff section of an AI prompt under `budget`.
 *
 * We deliberately spawn one `git diff` per file rather than one for everything:
 * it lets us stop as soon as the budget is spent, so a 200 MB staged blob is
 * never read into memory in the first place.
 */
export async function buildBudgetedStagedDiff(
	cwd: string,
	budget: DiffBudget
): Promise<BudgetedDiff> {
	const numstat = await execGit(['diff', '--cached', '--numstat', '-z', '-M'], cwd);
	const entries = parseNumstat(numstat.stdout);

	if (entries.length === 0) {
		return { text: '', truncated: false, isEmpty: true };
	}

	const statResult = await execGit(['diff', '--cached', '--stat=200', '-M'], cwd);
	const stat = statResult.stdout.trim();

	const skipped: string[] = [];
	const candidates: string[] = [];
	for (const entry of entries) {
		if (entry.isBinary || isGeneratedPath(entry.path)) {
			skipped.push(entry.path);
			continue;
		}
		candidates.push(entry.path);
	}

	const patches: string[] = [];
	let used = 0;
	let truncated = false;
	let filesOmitted = 0;

	for (const [index, filePath] of candidates.entries()) {
		if (index >= budget.maxFiles || used >= budget.totalBytes) {
			filesOmitted = candidates.length - index;
			truncated = true;
			break;
		}

		try {
			assertSafeGitPathOperand(filePath, 'diff path');
		} catch {
			skipped.push(filePath);
			continue;
		}

		const result = await execGit(
			[
				'diff',
				'--cached',
				'--no-color',
				`--unified=${budget.contextLines}`,
				'-M',
				'--',
				filePath
			],
			cwd
		);
		if (result.exitCode !== 0 || !result.stdout.trim()) continue;

		const remaining = budget.totalBytes - used;
		const limit = Math.min(budget.perFileBytes, remaining);
		const clipped = truncate(result.stdout.trimEnd(), limit);
		if (clipped.truncated) truncated = true;
		patches.push(clipped.text);
		used += clipped.text.length;
	}

	const sections: string[] = [];
	if (stat) sections.push(`Files changed:\n${stat}`);
	if (skipped.length > 0) {
		const shown = skipped.slice(0, 10).join(', ');
		const rest = skipped.length > 10 ? `, and ${skipped.length - 10} more` : '';
		sections.push(`Binary or generated files (diff omitted): ${shown}${rest}`);
	}
	if (patches.length > 0) {
		const header = truncated
			? 'Staged diff (sampled — some files or lines were omitted to fit context):'
			: 'Staged diff:';
		sections.push(`${header}\n${patches.join('\n')}`);
	}
	if (filesOmitted > 0) {
		sections.push(`${filesOmitted} further changed file(s) were omitted; see the file list above.`);
	}

	return { text: sections.join('\n\n'), truncated, isEmpty: false };
}
