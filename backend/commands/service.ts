/**
 * Command service — keeps the `commands` table and the on-disk canonical store
 * (`{clopenDir}/commands/<slug>.md`) in lockstep for the Settings → Commands
 * CRUD surface. Mirrors the Skills service shape, minus the marketplace.
 */

import { commandQueries, type CommandRow } from '$backend/database/queries';
import { parseDoc, serializeDoc, uniqueSlug, parseEngineMap, stringifyEngineMap, type EngineMap } from '$backend/artifacts';
import { debug } from '$shared/utils/logger';
import {
	writeCommandMd,
	readCommandMd,
	deleteCommandMd,
	commandFileExists
} from './store';

export interface CommandDTO {
	id: number;
	slug: string;
	name: string;
	description: string;
	argumentHint: string | null;
	/** Per-engine model override (EngineType → model id; absent = inherit). */
	modelByEngine: EngineMap;
	source: 'custom' | 'imported';
	enabled: boolean;
	/** False when the DB row exists but its `.md` is missing on disk. */
	present: boolean;
	createdAt: string;
}

export interface CommandInputFields {
	name: string;
	description: string;
	argumentHint?: string | null;
	modelByEngine?: EngineMap;
	body: string;
}

const FRONTMATTER_ORDER = ['description', 'argument-hint'];

function toDTO(row: CommandRow, present: boolean): CommandDTO {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		argumentHint: row.argument_hint,
		modelByEngine: parseEngineMap(row.model_by_engine),
		source: row.source,
		enabled: row.is_enabled === 1,
		present,
		createdAt: row.created_at
	};
}

/** An imported `.md` carries a single Claude-shaped model → map to the claude slot. */
function singleModelToMap(model: string | undefined): EngineMap {
	return model?.trim() ? { 'claude-code': model.trim() } : {};
}

/**
 * Serialize editor fields into the canonical command `.md` document. Model is
 * per-engine and injected at sync time, so it is NOT written here.
 */
function buildDocument(fields: CommandInputFields): string {
	const frontmatter: Record<string, string> = {};
	if (fields.description.trim()) frontmatter.description = fields.description.trim();
	if (fields.argumentHint?.trim()) frontmatter['argument-hint'] = fields.argumentHint.trim();
	return serializeDoc({ frontmatter, body: fields.body }, FRONTMATTER_ORDER);
}

export const commandService = {
	async list(): Promise<CommandDTO[]> {
		const rows = commandQueries.getAll();
		const presence = await Promise.all(rows.map(r => commandFileExists(r.slug)));
		return rows.map((row, i) => toDTO(row, presence[i]));
	},

	/**
	 * Minimal list of commands for the chat "/" picker. Non-admin surface
	 * (any user can invoke a command), so it exposes only display fields — no
	 * bodies, no source/disk metadata.
	 *
	 * `profileFilter` mirrors {@link syncCommands}'s semantics: when an active
	 * profile references ≥1 command, the picker shows exactly that set (even if
	 * a referenced command is globally disabled) instead of the enabled set.
	 */
	available(profileFilter?: Set<string> | null): { slug: string; name: string; description: string; argumentHint: string | null }[] {
		const rows = profileFilter
			? commandQueries.getAll().filter(r => profileFilter.has(r.slug))
			: commandQueries.getEnabled();
		return rows.map(r => ({
			slug: r.slug,
			name: r.name,
			description: r.description,
			argumentHint: r.argument_hint
		}));
	},

	async get(id: number): Promise<{ command: CommandDTO; body: string } | null> {
		const row = commandQueries.getById(id);
		if (!row) return null;
		const raw = await readCommandMd(row.slug);
		const body = raw ? parseDoc(raw).body : '';
		return { command: toDTO(row, raw !== null), body };
	},

	async create(input: CommandInputFields): Promise<CommandDTO> {
		if (!input.name.trim()) throw new Error('A command name is required');
		const slug = uniqueSlug(input.name, s => !!commandQueries.getBySlug(s));
		await writeCommandMd(slug, buildDocument(input));
		const row = commandQueries.insert({
			slug,
			name: input.name.trim(),
			description: input.description.trim(),
			argumentHint: input.argumentHint?.trim() || null,
			modelByEngine: stringifyEngineMap(input.modelByEngine),
			source: 'custom'
		});
		debug.log('commands', `📦 Created command: ${slug}`);
		return toDTO(row, true);
	},

	async update(id: number, input: CommandInputFields): Promise<CommandDTO> {
		const row = commandQueries.getById(id);
		if (!row) throw new Error('Command not found');
		await writeCommandMd(row.slug, buildDocument(input));
		commandQueries.updateMeta(
			id,
			input.name.trim(),
			input.description.trim(),
			input.argumentHint?.trim() || null,
			stringifyEngineMap(input.modelByEngine)
		);
		debug.log('commands', `🔧 Updated command: ${row.slug}`);
		return toDTO(commandQueries.getById(id)!, true);
	},

	/** Preview a pasted command `.md` (its frontmatter + body) before importing. */
	parsePreview(raw: string): { name: string; description: string; argumentHint: string | null; modelByEngine: EngineMap; body: string } {
		const parsed = parseDoc(raw);
		return {
			name: parsed.frontmatter.name || '',
			description: parsed.frontmatter.description || '',
			argumentHint: parsed.frontmatter['argument-hint'] || null,
			modelByEngine: singleModelToMap(parsed.frontmatter.model),
			body: parsed.body
		};
	},

	async import(raw: string, nameHint?: string): Promise<CommandDTO> {
		const parsed = parseDoc(raw);
		const displayName = (nameHint?.trim() || parsed.frontmatter.name || 'command').trim();
		return this.create({
			name: displayName,
			description: parsed.frontmatter.description || '',
			argumentHint: parsed.frontmatter['argument-hint'] || null,
			modelByEngine: singleModelToMap(parsed.frontmatter.model),
			body: parsed.body
		});
	},

	toggle(id: number, enabled: boolean): CommandDTO {
		const row = commandQueries.getById(id);
		if (!row) throw new Error('Command not found');
		commandQueries.setEnabled(id, enabled);
		return toDTO(commandQueries.getById(id)!, true);
	},

	async remove(id: number): Promise<void> {
		const row = commandQueries.getById(id);
		if (!row) throw new Error('Command not found');
		await deleteCommandMd(row.slug);
		commandQueries.remove(id);
		debug.log('commands', `🗑️ Deleted command: ${row.slug}`);
	}
};
