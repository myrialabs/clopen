/**
 * Engine sync for Subagents — a thin adapter over the shared artifact framework.
 * Enabled subagents are mirrored as `<slug>.md` into each engine's native agents
 * dir (Claude: `.../agents/`) or listed in a synthetic preamble for engines with
 * no native subagent concept (best-effort/unverified).
 *
 * Never throws — a stream never breaks because subagents couldn't sync.
 */

import { subagentQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import { materializeArtifacts, resolveArtifact, isPromptScopedEngine, parseDoc, serializeDoc, parseEngineMap, artifactEngineToType, type ManagedArtifact, type ArtifactEngine } from '$backend/artifacts';
import { artifactFilter } from '$backend/profiles';
import { readSubagentMd } from './store';

/**
 * Shape a subagent document for the engine's native format, injecting that
 * engine's own model/tool override (both are per-engine; the canonical `.md`
 * carries neither).
 *   - Claude reads a comma-list `tools` and a `model` in frontmatter.
 *   - OpenCode agents need `mode: subagent` and express `tools` as a map (not the
 *     Claude comma-list); we emit description + mode + model and drop `tools`
 *     rather than mistranslate the allowlist. See https://opencode.ai/docs/agents.
 *   - Other engines fall back to a synthetic preamble that ignores the document.
 */
function documentForEngine(engine: ArtifactEngine, raw: string, model?: string, tools?: string): string {
	const { frontmatter, body } = parseDoc(raw);
	if (engine === 'opencode') {
		const fm: Record<string, string> = { mode: 'subagent' };
		if (frontmatter.description) fm.description = frontmatter.description;
		if (model) fm.model = model;
		return serializeDoc({ frontmatter: fm, body }, ['description', 'mode', 'model']);
	}
	// Claude (and the default): re-serialize with the injected model/tools.
	const fm: Record<string, string> = { name: frontmatter.name };
	if (frontmatter.description) fm.description = frontmatter.description;
	if (tools) fm.tools = tools;
	if (model) fm.model = model;
	return serializeDoc({ frontmatter: fm, body }, ['name', 'description', 'tools', 'model']);
}

function buildSubagentsPreamble(items: ManagedArtifact[]): string {
	if (items.length === 0) return '';
	const lines = ['# Available Subagents', '', 'Specialized agent definitions you can delegate matching tasks to:', ''];
	for (const s of items) lines.push(`- **${s.name}** (${s.slug}) — ${s.description}`);
	return lines.join('\n');
}

/** The subagents active for a stream, narrowed by the active Profile (metadata only). */
function resolveEnabledSubagentsMeta(profileId?: number): ManagedArtifact[] {
	const filter = artifactFilter(profileId, 'subagent');
	return (filter ? subagentQueries.getAll() : subagentQueries.getEnabled())
		.filter(r => !filter || filter.has(r.slug))
		.map(r => ({ slug: r.slug, name: r.name, description: r.description }));
}

/**
 * The profile-scoped subagents preamble for PER-SESSION injection into a
 * prompt-scoped engine's prompt (OpenCode/Codex/Copilot). Returns '' when none
 * apply. Advisory: it steers which subagents the model delegates to, on top of
 * whatever the engine's own (possibly stale/shared) agent registry exposes.
 */
export function buildSubagentsPromptContext(profileId?: number): string {
	return buildSubagentsPreamble(resolveEnabledSubagentsMeta(profileId));
}

/** One inline Open Code agent definition (an `AgentConfig` in its config content). */
export interface OpenCodeInlineAgent {
	description?: string;
	mode: 'subagent';
	prompt: string;
	model?: string;
}

/**
 * The profile-scoped subagents as INLINE Open Code agent definitions, keyed by
 * slug. Open Code caches its agent registry from a shared dir at server boot, so
 * a per-session dir prune can't scope it; instead each per-Profile server is
 * built with exactly these agents inline (see the server pool). Returns the
 * enabled set narrowed by the active Profile (a referenced subagent counts even
 * if globally disabled — same presence-per-type rule as everywhere else).
 */
export async function buildOpenCodeInlineAgents(profileId?: number): Promise<Record<string, OpenCodeInlineAgent>> {
	const filter = artifactFilter(profileId, 'subagent');
	const rows = (filter ? subagentQueries.getAll() : subagentQueries.getEnabled())
		.filter(r => !filter || filter.has(r.slug));
	const out: Record<string, OpenCodeInlineAgent> = {};
	for (const row of rows) {
		const raw = await readSubagentMd(row.slug);
		if (raw == null) continue;
		const { frontmatter, body } = parseDoc(raw);
		const model = parseEngineMap(row.model_by_engine).opencode;
		out[row.slug] = {
			description: frontmatter.description || row.description,
			mode: 'subagent',
			prompt: body,
			...(model ? { model } : {})
		};
	}
	return out;
}

export async function syncSubagents(engine: ArtifactEngine, profileId?: number): Promise<void> {
	try {
		// Deliver subagents OUT-OF-BAND (not via the shared engine dir/block) when:
		//   - the target is SYNTHETIC on a prompt-scoped engine (Codex/Copilot) →
		//     injected into the prompt as a preamble; OR
		//   - the engine is OpenCode → each per-Profile server is built with the
		//     agents INLINE in its config (Open Code caches its agent registry from
		//     the shared dir at boot, so a per-session dir prune can't scope it).
		// In both cases materialize an EMPTY set so any stale dir/block is stripped.
		// Claude keeps its native filtered files; Qwen (per-query) keeps its preamble.
		const synthetic = resolveArtifact('subagent', { engine, scope: 'global' }).format === 'preamble-region';
		const viaPrompt = (synthetic && isPromptScopedEngine(engine)) || engine === 'opencode';
		const filter = artifactFilter(profileId, 'subagent');
		// A profile activates the subagents it references even if globally disabled;
		// with no profile filter, only the enabled set applies (unchanged).
		const rows = viaPrompt ? [] : (filter ? subagentQueries.getAll() : subagentQueries.getEnabled())
			.filter(r => !filter || filter.has(r.slug));
		const engineType = artifactEngineToType(engine);
		const enabled: ManagedArtifact[] = [];
		for (const row of rows) {
			const raw = await readSubagentMd(row.slug);
			if (raw == null) continue;
			const model = parseEngineMap(row.model_by_engine)[engineType];
			const tools = parseEngineMap(row.tools_by_engine)[engineType];
			enabled.push({ slug: row.slug, name: row.name, description: row.description, document: documentForEngine(engine, raw, model, tools) });
		}
		const managedSlugs = subagentQueries.getAll().map(r => r.slug);
		await materializeArtifacts('subagent', { engine, scope: 'global' }, {
			enabled,
			managedSlugs,
			buildPreamble: buildSubagentsPreamble
		});
		debug.log('subagents', `🤖 Synced ${enabled.length} subagent(s) → ${engine}`);
	} catch (error) {
		debug.warn('subagents', `⚠️ Subagent sync for ${engine} failed (continuing without):`, error);
	}
}

export async function syncSubagentsAllEngines(): Promise<void> {
	const engines: ArtifactEngine[] = ['claude', 'codex', 'copilot', 'qwen', 'opencode'];
	await Promise.all(engines.map(syncSubagents));
}
