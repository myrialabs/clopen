/**
 * Command Queries
 *
 * CRUD for user-managed custom slash Commands (Settings → Commands). Like
 * Skills, the `commands` table holds only METADATA + the enable toggle; the
 * command's Markdown document lives on disk in the canonical store under
 * `{clopenDir}/commands/<slug>.md` (see `backend/commands/store.ts`).
 */

import { getDatabase } from '../index';

export type CommandSource = 'custom' | 'imported';

export interface CommandRow {
	id: number;
	slug: string;
	name: string;
	description: string;
	argument_hint: string | null;
	/** JSON map of EngineType → model id ({} = inherit everywhere). */
	model_by_engine: string;
	source: CommandSource;
	is_enabled: number;
	created_at: string;
}

export interface CommandInput {
	slug: string;
	name: string;
	description: string;
	argumentHint?: string | null;
	/** JSON string: EngineType → model id. */
	modelByEngine?: string;
	source?: CommandSource;
}

export const commandQueries = {
	getAll(): CommandRow[] {
		return getDatabase().prepare(`SELECT * FROM commands ORDER BY created_at ASC`).all() as CommandRow[];
	},

	getEnabled(): CommandRow[] {
		return getDatabase().prepare(`SELECT * FROM commands WHERE is_enabled = 1 ORDER BY created_at ASC`).all() as CommandRow[];
	},

	getById(id: number): CommandRow | null {
		return getDatabase().prepare(`SELECT * FROM commands WHERE id = ?`).get(id) as CommandRow | null;
	},

	getBySlug(slug: string): CommandRow | null {
		return getDatabase().prepare(`SELECT * FROM commands WHERE slug = ?`).get(slug) as CommandRow | null;
	},

	insert(input: CommandInput): CommandRow {
		const result = getDatabase().prepare(
			`INSERT INTO commands (slug, name, description, argument_hint, model_by_engine, source)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run(
			input.slug,
			input.name,
			input.description,
			input.argumentHint ?? null,
			input.modelByEngine ?? '{}',
			input.source ?? 'custom'
		) as { lastInsertRowid: number | bigint };
		return this.getById(Number(result.lastInsertRowid))!;
	},

	updateMeta(id: number, name: string, description: string, argumentHint: string | null, modelByEngine: string): void {
		getDatabase().prepare(
			`UPDATE commands SET name = ?, description = ?, argument_hint = ?, model_by_engine = ? WHERE id = ?`
		).run(name, description, argumentHint, modelByEngine, id);
	},

	setEnabled(id: number, enabled: boolean): void {
		getDatabase().prepare(`UPDATE commands SET is_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
	},

	remove(id: number): void {
		getDatabase().prepare(`DELETE FROM commands WHERE id = ?`).run(id);
	}
};
