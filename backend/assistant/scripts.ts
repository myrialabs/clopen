/**
 * Scripts — saved, deterministic automations.
 *
 * When the same steps keep being run, an agent can save them as a script and
 * a job can run it on a schedule without spending a single token. A script is
 * text in the database (bash or Bun TypeScript) with named parameters; running
 * one writes it to a temporary file, runs it in the project folder (or the
 * assistant's folder) with the parameters as arguments and `CLOPEN_*`
 * environment variables, and captures its output, bounded in time and size.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { projectQueries, scriptQueries, type ScriptRow } from '$backend/database/queries';
import type { Script, ScriptParam, ScriptRunResult, ScriptRuntime, ScriptSource } from '$shared/types/assistant';
import { debug } from '$shared/utils/logger';
import { notifyAssistantChanged } from './events';
import { toScript } from './mappers';
import { getAssistantDirectory } from './project';

/** A script that runs longer than this is stopped. */
export const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
/** Output kept from a run — the tail, where the result and errors are. */
const MAX_OUTPUT = 40_000;

export function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'script'
	);
}

export function saveScript(input: {
	name: string;
	description?: string;
	runtime?: ScriptRuntime;
	content: string;
	params?: ScriptParam[];
	projectId?: string | null;
	source?: ScriptSource;
}): Script {
	const projectId = input.projectId ?? null;
	if (projectId && !projectQueries.getById(projectId)) throw new Error('That project does not exist.');
	const slug = slugify(input.name);
	const existing = scriptQueries.getBySlug(slug, projectId);
	const row = existing
		? scriptQueries.update(existing.id, {
				name: input.name,
				description: input.description,
				runtime: input.runtime,
				content: input.content,
				params: input.params
			})!
		: scriptQueries.create({
				slug,
				name: input.name,
				description: input.description,
				runtime: input.runtime,
				content: input.content,
				params: input.params,
				projectId,
				source: input.source
			});
	notifyAssistantChanged('scripts', row.id);
	return toScript(row);
}

/** Find a script by id or slug, preferring the project's own over a global one. */
export function findScript(ref: string, projectId: string | null = null): ScriptRow | null {
	const byId = scriptQueries.getById(ref);
	if (byId) return byId;
	const slug = slugify(ref);
	return (projectId ? scriptQueries.getBySlug(slug, projectId) : null) ?? scriptQueries.getBySlug(slug, null);
}

function workingDirectory(row: ScriptRow, projectId: string | null): string {
	const scoped = row.project_id ?? projectId;
	const project = scoped ? projectQueries.getById(scoped) : null;
	return project?.path ?? getAssistantDirectory();
}

export async function runScript(
	row: ScriptRow,
	args: string[] = [],
	options: { projectId?: string | null; timeoutMs?: number } = {}
): Promise<ScriptRunResult> {
	if (row.is_enabled !== 1) throw new Error(`The script "${row.name}" is turned off.`);
	const dir = mkdtempSync(join(tmpdir(), 'clopen-script-'));
	const file = join(dir, row.runtime === 'bun' ? 'script.ts' : 'script.sh');
	writeFileSync(file, row.content, { mode: 0o700 });

	const command = row.runtime === 'bun' ? [process.execPath, 'run', file, ...args] : ['bash', file, ...args];
	const cwd = workingDirectory(row, options.projectId ?? null);
	const params = Object.fromEntries(
		toScript(row).params.map((param, index) => [`CLOPEN_ARG_${param.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, args[index] ?? ''])
	);
	const started = Date.now();
	let timedOut = false;

	try {
		const proc = Bun.spawn(command, {
			cwd,
			env: { ...process.env, ...params, CLOPEN_SCRIPT: row.slug, CLOPEN_PROJECT_DIR: cwd },
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore'
		});
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, options.timeoutMs ?? SCRIPT_TIMEOUT_MS);
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		clearTimeout(timer);
		const output = [stdout, stderr ? `\n[stderr]\n${stderr}` : ''].join('').slice(-MAX_OUTPUT);
		scriptQueries.recordRun(row.id, exitCode);
		notifyAssistantChanged('scripts', row.id);
		return { exitCode: timedOut ? 124 : exitCode, output, durationMs: Date.now() - started, timedOut };
	} catch (error) {
		debug.warn('assistant', `Script ${row.slug} could not start:`, error);
		scriptQueries.recordRun(row.id, 127);
		return {
			exitCode: 127,
			output: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - started,
			timedOut: false
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
