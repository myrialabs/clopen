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
import { materializeArtifacts, parseDoc, type ManagedArtifact, type ArtifactEngine } from '$backend/artifacts';
import { readCommandMd } from './store';

/**
 * Shape a command document for the engine's native format:
 *   - Codex custom prompts are PLAIN markdown (no frontmatter) — emit the body.
 *   - Claude / OpenCode read frontmatter (`description`, …) — keep it verbatim.
 */
function documentForEngine(engine: ArtifactEngine, raw: string): string {
	if (engine === 'codex') return parseDoc(raw).body;
	return raw;
}

function buildCommandsPreamble(items: ManagedArtifact[]): string {
	if (items.length === 0) return '';
	const lines = ['# Available Commands', '', 'User-defined command prompts you can follow when the user invokes one by name:', ''];
	for (const c of items) lines.push(`- **/${c.slug}** — ${c.description || c.name}`);
	return lines.join('\n');
}

export async function syncCommands(engine: ArtifactEngine): Promise<void> {
	try {
		const rows = commandQueries.getEnabled();
		const enabled: ManagedArtifact[] = [];
		for (const row of rows) {
			const raw = await readCommandMd(row.slug);
			if (raw == null) continue; // file missing on disk — skip silently
			enabled.push({ slug: row.slug, name: row.name, description: row.description, document: documentForEngine(engine, raw) });
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
