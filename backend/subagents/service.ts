/**
 * Subagent service — keeps the `subagents` table and the on-disk canonical store
 * in lockstep for Settings → Subagents. Skills-shaped, plus a per-engine tool
 * allowlist and per-engine model override (JSON maps keyed by EngineType). The
 * canonical `.md` holds only name/description/body; model & tools are injected
 * per engine at sync time.
 */

import { subagentQueries, type SubagentRow } from '$backend/database/queries';
import { parseDoc, serializeDoc, uniqueSlug, parseEngineMap, stringifyEngineMap, normalizeToolList, type EngineMap } from '$backend/artifacts';
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
	/** Per-engine tool allowlist (EngineType → comma list; absent = all tools). */
	toolsByEngine: EngineMap;
	/** Per-engine model override (EngineType → model id; absent = inherit). */
	modelByEngine: EngineMap;
	source: 'custom' | 'imported';
	enabled: boolean;
	present: boolean;
	createdAt: string;
}

export interface SubagentInputFields {
	name: string;
	description: string;
	toolsByEngine?: EngineMap;
	modelByEngine?: EngineMap;
	body: string;
}

const FRONTMATTER_ORDER = ['name', 'description'];

function toDTO(row: SubagentRow, present: boolean): SubagentDTO {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		toolsByEngine: parseEngineMap(row.tools_by_engine),
		modelByEngine: parseEngineMap(row.model_by_engine),
		source: row.source,
		enabled: row.is_enabled === 1,
		present,
		createdAt: row.created_at
	};
}

/** Normalise each per-engine tool allowlist string into `a, b, c`. */
function normalizeToolsMap(map: EngineMap | undefined): EngineMap {
	const out: EngineMap = {};
	for (const [engine, list] of Object.entries(map ?? {})) {
		const normalized = normalizeToolList(list);
		if (normalized) out[engine as keyof EngineMap] = normalized;
	}
	return out;
}

/** An imported Claude-shaped `.md` maps its single frontmatter value → claude slot. */
function singleToMap(value: string | undefined): EngineMap {
	return value?.trim() ? { 'claude-code': value.trim() } : {};
}

/** Canonical doc holds name + description only; model/tools are per-engine (sync-injected). */
function buildDocument(slug: string, fields: SubagentInputFields): string {
	const frontmatter: Record<string, string> = { name: slug };
	if (fields.description.trim()) frontmatter.description = fields.description.trim();
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
			toolsByEngine: stringifyEngineMap(normalizeToolsMap(input.toolsByEngine)),
			modelByEngine: stringifyEngineMap(input.modelByEngine),
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
			stringifyEngineMap(normalizeToolsMap(input.toolsByEngine)),
			stringifyEngineMap(input.modelByEngine)
		);
		debug.log('subagents', `🔧 Updated subagent: ${row.slug}`);
		return toDTO(subagentQueries.getById(id)!, true);
	},

	parsePreview(raw: string): { name: string; description: string; toolsByEngine: EngineMap; modelByEngine: EngineMap; body: string } {
		const parsed = parseDoc(raw);
		return {
			name: parsed.frontmatter.name || '',
			description: parsed.frontmatter.description || '',
			toolsByEngine: singleToMap(parsed.frontmatter.tools),
			modelByEngine: singleToMap(parsed.frontmatter.model),
			body: parsed.body
		};
	},

	async import(raw: string, nameHint?: string): Promise<SubagentDTO> {
		const parsed = parseDoc(raw);
		const displayName = (nameHint?.trim() || parsed.frontmatter.name || 'subagent').trim();
		return this.create({
			name: displayName,
			description: parsed.frontmatter.description || '',
			toolsByEngine: singleToMap(parsed.frontmatter.tools),
			modelByEngine: singleToMap(parsed.frontmatter.model),
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
