/**
 * Subagent service — keeps the `subagents` table and the on-disk canonical store
 * in lockstep for Settings → Subagents. Skills-shaped, plus a tool allowlist,
 * model override, and agent type carried in the document frontmatter.
 */

import { subagentQueries, type SubagentRow } from '$backend/database/queries';
import { parseDoc, serializeDoc, uniqueSlug } from '$backend/artifacts';
import { debug } from '$shared/utils/logger';
import {
	writeSubagentMd,
	readSubagentMd,
	deleteSubagentMd,
	subagentFileExists
} from './store';

export interface SubagentDTO {
	id: number;
	slug: string;
	name: string;
	description: string;
	/** Comma-separated tool allowlist ('' = all tools). */
	tools: string;
	model: string | null;
	agentType: string | null;
	source: 'custom' | 'imported';
	enabled: boolean;
	present: boolean;
	createdAt: string;
}

export interface SubagentInputFields {
	name: string;
	description: string;
	tools?: string | null;
	model?: string | null;
	agentType?: string | null;
	body: string;
}

const FRONTMATTER_ORDER = ['name', 'description', 'tools', 'model', 'agent-type'];

function toDTO(row: SubagentRow, present: boolean): SubagentDTO {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		tools: row.tools ?? '',
		model: row.model,
		agentType: row.agent_type,
		source: row.source,
		enabled: row.is_enabled === 1,
		present,
		createdAt: row.created_at
	};
}

/** Normalise a tool allowlist string (comma/space separated) into `a, b, c`. */
function normalizeTools(tools?: string | null): string | null {
	if (!tools) return null;
	const list = tools.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
	return list.length ? list.join(', ') : null;
}

function buildDocument(slug: string, fields: SubagentInputFields): string {
	const frontmatter: Record<string, string> = { name: slug };
	if (fields.description.trim()) frontmatter.description = fields.description.trim();
	const tools = normalizeTools(fields.tools);
	if (tools) frontmatter.tools = tools;
	if (fields.model?.trim()) frontmatter.model = fields.model.trim();
	if (fields.agentType?.trim()) frontmatter['agent-type'] = fields.agentType.trim();
	return serializeDoc({ frontmatter, body: fields.body }, FRONTMATTER_ORDER);
}

export const subagentService = {
	async list(): Promise<SubagentDTO[]> {
		const rows = subagentQueries.getAll();
		const presence = await Promise.all(rows.map(r => subagentFileExists(r.slug)));
		return rows.map((row, i) => toDTO(row, presence[i]));
	},

	async get(id: number): Promise<{ subagent: SubagentDTO; body: string } | null> {
		const row = subagentQueries.getById(id);
		if (!row) return null;
		const raw = await readSubagentMd(row.slug);
		const body = raw ? parseDoc(raw).body : '';
		return { subagent: toDTO(row, raw !== null), body };
	},

	async create(input: SubagentInputFields): Promise<SubagentDTO> {
		if (!input.name.trim()) throw new Error('A subagent name is required');
		if (!input.description.trim()) throw new Error('A subagent description is required');
		const slug = uniqueSlug(input.name, s => !!subagentQueries.getBySlug(s));
		await writeSubagentMd(slug, buildDocument(slug, input));
		const row = subagentQueries.insert({
			slug,
			name: input.name.trim(),
			description: input.description.trim(),
			tools: normalizeTools(input.tools),
			model: input.model?.trim() || null,
			agentType: input.agentType?.trim() || null,
			source: 'custom'
		});
		debug.log('subagents', `📦 Created subagent: ${slug}`);
		return toDTO(row, true);
	},

	async update(id: number, input: SubagentInputFields): Promise<SubagentDTO> {
		const row = subagentQueries.getById(id);
		if (!row) throw new Error('Subagent not found');
		if (!input.description.trim()) throw new Error('A subagent description is required');
		await writeSubagentMd(row.slug, buildDocument(row.slug, input));
		subagentQueries.updateMeta(
			id,
			input.name.trim(),
			input.description.trim(),
			normalizeTools(input.tools),
			input.model?.trim() || null,
			input.agentType?.trim() || null
		);
		debug.log('subagents', `🔧 Updated subagent: ${row.slug}`);
		return toDTO(subagentQueries.getById(id)!, true);
	},

	parsePreview(raw: string): { name: string; description: string; tools: string; model: string | null; agentType: string | null; body: string } {
		const parsed = parseDoc(raw);
		return {
			name: parsed.frontmatter.name || '',
			description: parsed.frontmatter.description || '',
			tools: parsed.frontmatter.tools || '',
			model: parsed.frontmatter.model || null,
			agentType: parsed.frontmatter['agent-type'] || null,
			body: parsed.body
		};
	},

	async import(raw: string, nameHint?: string): Promise<SubagentDTO> {
		const parsed = parseDoc(raw);
		const displayName = (nameHint?.trim() || parsed.frontmatter.name || 'subagent').trim();
		return this.create({
			name: displayName,
			description: parsed.frontmatter.description || '',
			tools: parsed.frontmatter.tools || null,
			model: parsed.frontmatter.model || null,
			agentType: parsed.frontmatter['agent-type'] || null,
			body: parsed.body
		});
	},

	toggle(id: number, enabled: boolean): SubagentDTO {
		const row = subagentQueries.getById(id);
		if (!row) throw new Error('Subagent not found');
		subagentQueries.setEnabled(id, enabled);
		return toDTO(subagentQueries.getById(id)!, true);
	},

	async remove(id: number): Promise<void> {
		const row = subagentQueries.getById(id);
		if (!row) throw new Error('Subagent not found');
		await deleteSubagentMd(row.slug);
		subagentQueries.remove(id);
		debug.log('subagents', `🗑️ Deleted subagent: ${row.slug}`);
	}
};
