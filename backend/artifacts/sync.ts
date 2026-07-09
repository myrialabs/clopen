/**
 * Generic artifact materializer — the single writer all file-shaped artifact
 * features route through. Given the resolved contract for an engine, it either
 * mirrors folders/files into a native directory (pruning only Clopen-managed
 * slugs) or rewrites a marker-delimited preamble block in a shared memory file.
 *
 * This replaces the per-feature sync copies: Skills, Commands and Subagents all
 * call {@link materializeArtifacts} with their own item set and (optionally) a
 * custom preamble builder, so behavior stays identical across features.
 */

import { join } from 'path';
import { mkdir, readdir, rm, writeFile, cp, stat } from 'node:fs/promises';
import { resolveArtifact } from './matrix';
import { markersFor, writeManagedBlock } from './markers';
import type { ArtifactContext, ArtifactType, ManagedArtifact } from './types';

/**
 * Managed-block marker id per artifact type (uppercased feature name). `'mcp'`
 * and `'permission'` are excluded: neither routes through this generic
 * file-materializer (MCP is a config-object path; permissions have their own
 * runtime-hook enforcement + `backend/permissions/materialize.ts`).
 */
const MARKER_ID: Record<Exclude<ArtifactType, 'mcp' | 'permission'>, string> = {
	skill: 'SKILLS',
	command: 'COMMANDS',
	subagent: 'SUBAGENTS',
	instruction: 'INSTRUCTIONS'
};

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Mirror one canonical folder into a destination dir under `<slug>/` (replacing any stale copy). */
async function mirrorFolder(sourceDir: string, destDir: string, slug: string): Promise<void> {
	if (!(await pathExists(sourceDir))) return;
	const dest = join(destDir, slug);
	await rm(dest, { recursive: true, force: true });
	await mkdir(destDir, { recursive: true });
	await cp(sourceDir, dest, { recursive: true });
}

/** Default synthetic preamble — a generic "these artifacts exist" block. */
function defaultPreamble(type: ArtifactType, items: ManagedArtifact[]): string {
	if (items.length === 0) return '';
	const label = type === 'command' ? 'Commands' : type === 'subagent' ? 'Subagents' : 'Items';
	const lines = [`# Available ${label}`, ''];
	for (const item of items) lines.push(`- **${item.name}** — ${item.description}`);
	return lines.join('\n');
}

export interface MaterializeInput {
	/** Items that should exist after the sync (enabled set). */
	enabled: ManagedArtifact[];
	/** Every slug this feature manages — used to prune safely without touching user files. */
	managedSlugs: string[];
	/** Optional custom synthetic preamble (Skills keeps its exact original text). */
	buildPreamble?: (items: ManagedArtifact[]) => string;
}

/**
 * Materialize a feature's artifacts for one engine. Safe to call at every stream
 * start: native dirs are reconciled and synthetic blocks are rewritten in place.
 */
export async function materializeArtifacts(
	type: Exclude<ArtifactType, 'mcp' | 'instruction'>,
	ctx: ArtifactContext,
	input: MaterializeInput
): Promise<void> {
	const resolution = resolveArtifact(type, ctx);
	if (!resolution.supported) return;

	const target = resolution.locateEffective(ctx);
	if (!target) return;

	const enabledSlugs = new Set(input.enabled.map(i => i.slug));
	const managedSlugs = new Set(input.managedSlugs);

	if (resolution.format === 'folder-md' || resolution.format === 'single-md') {
		await mkdir(target, { recursive: true });

		// Prune stale copies. In an EXCLUSIVE (Clopen-owned isolated) dir we remove
		// anything not currently enabled — this is what reclaims artifacts whose DB
		// row was deleted (their slug is gone from managedSlugs). In a SHARED dir we
		// only prune known managed slugs, never the user's own files.
		for (const entry of await readdir(target, { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const slug = resolution.format === 'single-md' ? entry.name.replace(/\.md$/, '') : entry.name;
			const stale = resolution.exclusive
				? !enabledSlugs.has(slug)
				: managedSlugs.has(slug) && !enabledSlugs.has(slug);
			if (stale) {
				await rm(join(target, entry.name), { recursive: true, force: true });
			}
		}

		for (const item of input.enabled) {
			if (resolution.format === 'folder-md') {
				if (item.sourceDir) await mirrorFolder(item.sourceDir, target, item.slug);
			} else if (item.document != null) {
				await writeFile(join(target, `${item.slug}.md`), item.document, 'utf8');
			}
		}

		// A type that is NATIVE for this engine must not ALSO leave a stale synthetic
		// managed block in the memory file. Engines that USED to be synthetic for a
		// type before a native dir was added (OpenCode subagents/commands, Codex
		// commands) still carry an orphaned `CLOPEN:<TYPE>` block in AGENTS.md that
		// the native sync never touches — so a deleted/renamed artifact would linger
		// there forever (e.g. a removed subagent still "available"). Strip it here;
		// writeManagedBlock is a no-op when no such block exists.
		const staleMemoryFile = resolveArtifact('instruction', ctx).locateEffective(ctx);
		if (staleMemoryFile) {
			await writeManagedBlock(staleMemoryFile, '', markersFor(MARKER_ID[type as keyof typeof MARKER_ID]));
		}
		return;
	}

	// preamble-region → managed block inside the engine memory file. `type` is
	// always one of the file-materialized kinds here (mcp/permission never route
	// through this writer), so the MARKER_ID lookup is total in practice.
	const build = input.buildPreamble ?? ((items) => defaultPreamble(type, items));
	await writeManagedBlock(target, build(input.enabled), markersFor(MARKER_ID[type as keyof typeof MARKER_ID]));
}
