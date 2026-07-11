/**
 * Engine sync for Commands — a thin adapter over the shared artifact framework.
 * Enabled commands are mirrored as `<slug>.md` into each engine's native
 * commands dir (Claude: `.../commands/`) or listed in a synthetic preamble for
 * engines with no native command concept (best-effort/unverified).
 *
 * Never throws — a stream never breaks because commands couldn't sync.
 */

import { commandQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import { materializeArtifacts, resolveArtifact, isPromptScopedEngine, parseDoc, serializeDoc, parseEngineMap, artifactEngineToType, type ManagedArtifact, type ArtifactEngine } from '$backend/artifacts';
import { artifactFilter } from '$backend/profiles';
import { readCommandMd } from './store';

/**
 * Shape a command document for the engine's native format, injecting that
 * engine's model override (per-engine; the canonical `.md` carries no model):
 *   - Codex custom prompts are PLAIN markdown (no frontmatter, no model) — emit the body.
 *   - Claude / OpenCode read frontmatter — re-serialize with the injected model.
 */
function documentForEngine(engine: ArtifactEngine, raw: string, model?: string): string {
	const { frontmatter, body } = parseDoc(raw);
	if (engine === 'codex') return body;
	const fm: Record<string, string> = {};
	if (frontmatter.description) fm.description = frontmatter.description;
	if (frontmatter['argument-hint']) fm['argument-hint'] = frontmatter['argument-hint'];
	if (model) fm.model = model;
	return serializeDoc({ frontmatter: fm, body }, ['description', 'argument-hint', 'model']);
}

function buildCommandsPreamble(items: ManagedArtifact[]): string {
	if (items.length === 0) return '';
	const lines = ['# Available Commands', '', 'User-defined command prompts you can follow when the user invokes one by name:', ''];
	for (const c of items) lines.push(`- **/${c.slug}** — ${c.description || c.name}`);
	return lines.join('\n');
}

/** The commands active for a stream, narrowed by the active Profile (metadata only). */
function resolveEnabledCommandsMeta(profileId?: number): ManagedArtifact[] {
	const filter = artifactFilter(profileId, 'command');
	return (filter ? commandQueries.getAll() : commandQueries.getEnabled())
		.filter(r => !filter || filter.has(r.slug))
		.map(r => ({ slug: r.slug, name: r.name, description: r.description }));
}

/**
 * The profile-scoped commands preamble for PER-SESSION injection into a
 * prompt-scoped engine's prompt (OpenCode/Codex/Copilot). Returns '' when none
 * apply. Advisory: it scopes what the model surfaces/uses, on top of whatever the
 * engine's own (possibly stale/shared) command registry exposes.
 */
export function buildCommandsPromptContext(profileId?: number): string {
	return buildCommandsPreamble(resolveEnabledCommandsMeta(profileId));
}

export async function syncCommands(engine: ArtifactEngine, profileId?: number): Promise<void> {
	try {
		// On a prompt-scoped engine, a SYNTHETIC command target (no native command
		// dir — Copilot) is delivered per-session via prompt injection instead, so
		// materialize an empty set to strip any shared global block that would leak
		// across sessions. NATIVE command engines (Claude/OpenCode/Codex) keep the
		// filtered files on disk; Qwen (per-query) keeps its synthetic preamble.
		const synthetic = resolveArtifact('command', { engine, scope: 'global' }).format === 'preamble-region';
		const viaPrompt = synthetic && isPromptScopedEngine(engine);
		const filter = artifactFilter(profileId, 'command');
		// A profile activates the commands it references even if globally disabled;
		// with no profile filter, only the enabled set applies (unchanged).
		const rows = viaPrompt ? [] : (filter ? commandQueries.getAll() : commandQueries.getEnabled())
			.filter(r => !filter || filter.has(r.slug));
		const engineType = artifactEngineToType(engine);
		const enabled: ManagedArtifact[] = [];
		for (const row of rows) {
			const raw = await readCommandMd(row.slug);
			if (raw == null) continue; // file missing on disk — skip silently
			const model = parseEngineMap(row.model_by_engine)[engineType];
			enabled.push({ slug: row.slug, name: row.name, description: row.description, document: documentForEngine(engine, raw, model) });
		}
		const managedSlugs = commandQueries.getAll().map(r => r.slug);
		await materializeArtifacts('command', { engine, scope: 'global' }, {
			enabled,
			managedSlugs,
			buildPreamble: buildCommandsPreamble
		});
		debug.log('commands', `⌨️ Synced ${enabled.length} command(s) → ${engine}`);
	} catch (error) {
		debug.warn('commands', `⚠️ Command sync for ${engine} failed (continuing without):`, error);
	}
}

export async function syncCommandsAllEngines(): Promise<void> {
	const engines: ArtifactEngine[] = ['claude', 'codex', 'copilot', 'qwen', 'opencode'];
	await Promise.all(engines.map(syncCommands));
}
