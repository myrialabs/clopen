/**
 * Detect & link — discover artifacts that already exist on disk (in Clopen's
 * effective engine dirs AND in the user's real standard locations), and adopt a
 * real one into the effective dir via symlink so it takes effect for Clopen's
 * engines without moving the user's file.
 *
 * "Honest to on-disk" (we report what's actually there) AND "effective for
 * Clopen" (adoption uses a symlink into the isolated engine dir). Only slugs the
 * user chooses to adopt are ever touched.
 */

import { join } from 'path';
import { readdir, readFile, stat, symlink, mkdir, lstat, rm } from 'node:fs/promises';
import { debug } from '$shared/utils/logger';
import { resolveArtifact } from './matrix';
import { readManagedBlock, markersFor } from './markers';
import type { ArtifactContext, ArtifactType, DetectedArtifact } from './types';

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Cheap frontmatter name/description reader (no full YAML parse). */
async function readMeta(file: string): Promise<{ name?: string; description?: string }> {
	try {
		const raw = await readFile(file, 'utf8');
		const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(raw.replace(/^\uFEFF/, ''));
		if (!m) return {};
		const out: { name?: string; description?: string } = {};
		for (const line of m[1].split(/\r?\n/)) {
			const kv = /^(name|description):\s*(.*)$/.exec(line);
			if (kv) out[kv[1] as 'name' | 'description'] = kv[2].replace(/^["']|["']$/g, '').trim();
		}
		return out;
	} catch {
		return {};
	}
}

/** List `<slug>` artifacts inside a folder-md / single-md directory. */
async function scanDir(dir: string, format: 'folder-md' | 'single-md', managed: boolean, adoptable: boolean): Promise<DetectedArtifact[]> {
	if (!(await pathExists(dir))) return [];
	const out: DetectedArtifact[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		if (format === 'folder-md') {
			if (!entry.isDirectory()) continue;
			const slug = entry.name;
			const meta = await readMeta(join(dir, slug, 'SKILL.md'));
			out.push({ slug, name: meta.name || slug, description: meta.description || '', path: join(dir, slug), managed, adoptable });
		} else {
			if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
			const slug = entry.name.replace(/\.md$/, '');
			const meta = await readMeta(join(dir, entry.name));
			out.push({ slug, name: meta.name || slug, description: meta.description || '', path: join(dir, entry.name), managed, adoptable });
		}
	}
	return out;
}

/**
 * Detect artifacts of a type for one engine/scope. Merges Clopen-managed
 * effective locations with the user's real standard locations (deduped by slug,
 * effective winning) so the UI can show what exists and what can be adopted.
 */
export async function detectArtifacts(type: ArtifactType, ctx: ArtifactContext): Promise<DetectedArtifact[]> {
	const resolution = resolveArtifact(type, ctx);
	if (!resolution.supported) return [];

	const bySlug = new Map<string, DetectedArtifact>();

	if (resolution.format === 'preamble-region') {
		const file = resolution.locateEffective(ctx);
		if (file && (await pathExists(file))) {
			const block = readManagedBlock(await readFile(file, 'utf8'), markersFor('INSTRUCTIONS'));
			if (block != null) {
				bySlug.set('instructions', { slug: 'instructions', name: 'Project instructions', description: '', path: file, managed: true, adoptable: false });
			}
		}
		return [...bySlug.values()];
	}

	// Detection only applies to the directory-backed formats (Skills' `folder-md`,
	// Commands'/Subagents' `single-md`). Other formats (`json`/`toml`/preamble)
	// have no scannable artifact directory — nothing to detect on disk.
	if (resolution.format !== 'folder-md' && resolution.format !== 'single-md') return [];
	const format = resolution.format;
	const effective = await scanDir(resolution.locateEffective(ctx), format, true, false);
	for (const a of effective) bySlug.set(a.slug, a);

	for (const real of resolution.locateReal?.(ctx) ?? []) {
		for (const a of await scanDir(real, format, false, true)) {
			if (!bySlug.has(a.slug)) bySlug.set(a.slug, a);
		}
	}

	return [...bySlug.values()];
}

/**
 * Adopt a real on-disk artifact into the engine's effective dir via symlink, so
 * it takes effect for Clopen's isolated engine without relocating the user's
 * file. Returns the symlink path created.
 */
export async function adoptArtifact(type: ArtifactType, ctx: ArtifactContext, realPath: string, slug: string): Promise<string> {
	const resolution = resolveArtifact(type, ctx);
	if (!resolution.supported || resolution.format === 'preamble-region') {
		throw new Error(`Artifact type "${type}" cannot be adopted by link`);
	}
	const effectiveDir = resolution.locateEffective(ctx);
	await mkdir(effectiveDir, { recursive: true });
	const linkPath = join(effectiveDir, resolution.format === 'single-md' ? `${slug}.md` : slug);

	// Replace any existing entry at the link path (idempotent adoption).
	try {
		await lstat(linkPath);
		await rm(linkPath, { recursive: true, force: true });
	} catch {
		/* nothing there */
	}
	await symlink(realPath, linkPath);
	debug.log('artifacts', `🔗 Adopted ${type} "${slug}" → ${linkPath}`);
	return linkPath;
}
