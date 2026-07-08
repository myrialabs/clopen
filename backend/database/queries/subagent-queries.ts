/**
 * Subagent Queries
 *
 * CRUD for user-managed custom Subagents (Settings → Subagents). Subagents are
 * Skills-shaped (a Markdown document with frontmatter) plus three extra fields:
 * a tool allowlist, a model override, and an agent type. The `subagents` table
 * holds metadata + the enable toggle; the document lives on disk under
 * `{clopenDir}/subagents/<slug>.md` (see `backend/subagents/store.ts`).
 */

import { getDatabase } from '../index';

export type SubagentSource = 'custom' | 'imported';

export interface SubagentRow {
	id: number;
	slug: string;
	name: string;
	description: string;
	/** Comma-separated tool allowlist (empty/null = all tools). */
	tools: string | null;
	model: string | null;
	agent_type: string | null;
	source: SubagentSource;
	is_enabled: number;
	created_at: string;
}

export interface SubagentInput {
	slug: string;
	name: string;
	description: string;
	tools?: string | null;
	model?: string | null;
	agentType?: string | null;
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
			`INSERT INTO subagents (slug, name, description, tools, model, agent_type, source)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(
			input.slug,
			input.name,
			input.description,
			input.tools ?? null,
			input.model ?? null,
			input.agentType ?? null,
			input.source ?? 'custom'
		) as { lastInsertRowid: number | bigint };
		return this.getById(Number(result.lastInsertRowid))!;
	},

	updateMeta(
		id: number,
		name: string,
		description: string,
		tools: string | null,
		model: string | null,
		agentType: string | null
	): void {
		getDatabase().prepare(
			`UPDATE subagents SET name = ?, description = ?, tools = ?, model = ?, agent_type = ? WHERE id = ?`
		).run(name, description, tools, model, agentType, id);
	},

	setEnabled(id: number, enabled: boolean): void {
		getDatabase().prepare(`UPDATE subagents SET is_enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
	},

	remove(id: number): void {
		getDatabase().prepare(`DELETE FROM subagents WHERE id = ?`).run(id);
	}
};
