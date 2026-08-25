/**
 * Subagent Queries
 *
 * CRUD for user-managed custom Subagents (Settings → Subagents). Subagents are
 * Skills-shaped (a Markdown document with frontmatter) plus a per-engine tool
 * allowlist and per-engine model override (stored as JSON maps keyed by
 * EngineType). The `subagents` table holds metadata + the enable toggle; the
 * document body lives on disk under `{clopenDir}/subagents/<slug>.md` (see
 * `backend/subagents/store.ts`).
 */

import { getDatabase } from '../index';

export type SubagentSource = 'custom' | 'imported';

export interface SubagentRow {
	id: number;
	slug: string;
	name: string;
	description: string;
	/** JSON map of EngineType → comma-separated tool allowlist ({} = all tools). */
	tools_by_engine: string;
	/** JSON map of EngineType → model id ({} = inherit everywhere). */
	model_by_engine: string;
	source: SubagentSource;
	is_enabled: number;
	created_at: string;
}

export interface SubagentInput {
	slug: string;
	name: string;
	description: string;
	/** JSON string: EngineType → comma-separated tool allowlist. */
	toolsByEngine?: string;
	/** JSON string: EngineType → model id. */
	modelByEngine?: string;
	source?: SubagentSource;
}

export const subagentQueries = {
	getAll(): SubagentRow[] {
		return getDatabase().prepare(`SELECT * FROM subagents ORDER BY created_at ASC`).all() as SubagentRow[];
	},

	getEnabled(): SubagentRow[] {
		return getDatabase().prepare(`SELECT * FROM subagents WHERE is_enabled = 1 ORDER BY created_at ASC`).all() as SubagentRow[];
	},

	getById(id: number): SubagentRow | null {
		return getDatabase().prepare(`SELECT * FROM subagents WHERE id = ?`).get(id) as SubagentRow | null;
	},

	getBySlug(slug: string): SubagentRow | null {
		return getDatabase().prepare(`SELECT * FROM subagents WHERE slug = ?`).get(slug) as SubagentRow | null;
	},

	insert(input: SubagentInput): SubagentRow {
		const result = getDatabase().prepare(
			`INSERT INTO subagents (slug, name, description, tools_by_engine, model_by_engine, source)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run(
			input.slug,
			input.name,
			input.description,
			input.toolsByEngine ?? '{}',
			input.modelByEngine ?? '{}',
			input.source ?? 'custom'
		) as { lastInsertRowid: number | bigint };
		return this.getById(Number(result.lastInsertRowid))!;
	},

	updateMeta(
		id: number,
		name: string,
		description: string,
		toolsByEngine: string,
		modelByEngine: string
	): void {
		getDatabase().prepare(
			`UPDATE subagents SET name = ?, description = ?, tools_by_engine = ?, model_by_engine = ? WHERE id = ?`
		).run(name, description, toolsByEngine, modelByEngine, id);
	},

	setEnabled(id: number, enabled: boolean): void {
		getDatabase().prepare(`UPDATE subagents SET is_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
	},

	remove(id: number): void {
		getDatabase().prepare(`DELETE FROM subagents WHERE id = ?`).run(id);
	}
};
