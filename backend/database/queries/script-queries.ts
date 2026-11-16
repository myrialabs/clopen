/**
 * Scripts — saved deterministic automations. Global (`project_id` null) or
 * scoped to one project; the slug is unique within its scope.
 */

import { getDatabase } from '../index';
import type { ScriptParam, ScriptRuntime, ScriptSource } from '$shared/types/assistant';

export interface ScriptRow {
	id: string;
	slug: string;
	name: string;
	description: string;
	runtime: ScriptRuntime;
	content: string;
	params: string;
	project_id: string | null;
	source: ScriptSource;
	is_enabled: number;
	run_count: number;
	last_run_at: string | null;
	last_exit_code: number | null;
	created_at: string;
	updated_at: string;
}

export interface ScriptInput {
	slug: string;
	name: string;
	description?: string;
	runtime?: ScriptRuntime;
	content: string;
	params?: ScriptParam[];
	projectId?: string | null;
	source?: ScriptSource;
	enabled?: boolean;
}

export function parseParams(raw: string): ScriptParam[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed
					.filter((item) => item && typeof item.name === 'string')
					.map((item) => ({ name: item.name as string, description: typeof item.description === 'string' ? item.description : '' }))
			: [];
	} catch {
		return [];
	}
}

export const scriptQueries = {
	create(input: ScriptInput): ScriptRow {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO scripts (id, slug, name, description, runtime, content, params, project_id, source, is_enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			input.slug,
			input.name,
			input.description ?? '',
			input.runtime ?? 'bash',
			input.content,
			JSON.stringify(input.params ?? []),
			input.projectId ?? null,
			input.source ?? 'user',
			input.enabled === false ? 0 : 1,
			now,
			now
		);
		return scriptQueries.getById(id)!;
	},

	getById(id: string): ScriptRow | null {
		return (getDatabase().prepare('SELECT * FROM scripts WHERE id = ?').get(id) as ScriptRow | undefined) ?? null;
	},

	getBySlug(slug: string, projectId: string | null): ScriptRow | null {
		return (
			(getDatabase()
				.prepare(`SELECT * FROM scripts WHERE slug = ? AND IFNULL(project_id, '') = IFNULL(?, '')`)
				.get(slug, projectId) as ScriptRow | undefined) ?? null
		);
	},

	/** Global scripts plus, when a project is given, that project's own. */
	list(projectId?: string | null): ScriptRow[] {
		const db = getDatabase();
		if (projectId === undefined) {
			return db.prepare('SELECT * FROM scripts ORDER BY name').all() as ScriptRow[];
		}
		return db
			.prepare('SELECT * FROM scripts WHERE project_id IS NULL OR project_id = ? ORDER BY name')
			.all(projectId) as ScriptRow[];
	},

	update(id: string, patch: Partial<ScriptInput>): ScriptRow | null {
		const db = getDatabase();
		const sets: string[] = [];
		const values: unknown[] = [];
		const put = (column: string, value: unknown) => {
			sets.push(`${column} = ?`);
			values.push(value);
		};
		if (patch.slug !== undefined) put('slug', patch.slug);
		if (patch.name !== undefined) put('name', patch.name);
		if (patch.description !== undefined) put('description', patch.description);
		if (patch.runtime !== undefined) put('runtime', patch.runtime);
		if (patch.content !== undefined) put('content', patch.content);
		if (patch.params !== undefined) put('params', JSON.stringify(patch.params));
		if (patch.projectId !== undefined) put('project_id', patch.projectId);
		if (patch.enabled !== undefined) put('is_enabled', patch.enabled ? 1 : 0);
		if (sets.length === 0) return scriptQueries.getById(id);
		put('updated_at', new Date().toISOString());
		db.prepare(`UPDATE scripts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
		return scriptQueries.getById(id);
	},

	recordRun(id: string, exitCode: number): void {
		getDatabase()
			.prepare('UPDATE scripts SET run_count = run_count + 1, last_run_at = ?, last_exit_code = ? WHERE id = ?')
			.run(new Date().toISOString(), exitCode, id);
	},

	delete(id: string): void {
		getDatabase().prepare('DELETE FROM scripts WHERE id = ?').run(id);
	}
};
