/**
 * Materialization must be IDEMPOTENT on disk, not just in outcome.
 *
 * `materializeArtifacts` runs at every stream start. It used to rewrite each
 * enabled artifact unconditionally, which left the content identical but moved
 * the file's mtime — and the Open Code pool fingerprints exactly these files to
 * decide whether its baked config changed. The result was a brand-new
 * `opencode serve` process for every single turn. These tests pin the property
 * that prevents it: no content change, no write.
 */

import { describe, expect, test, afterAll } from 'bun:test';
import { rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { materializeArtifacts } from './sync';
import { resolveArtifact } from './matrix';
import type { ArtifactContext } from './types';

const CONTEXT: ArtifactContext = { engine: 'opencode', scope: 'global' };
const SLUG = 'sync-idempotence-fixture';

const targetDir = resolveArtifact('command', CONTEXT).locateEffective(CONTEXT);
const targetFile = targetDir ? join(targetDir, `${SLUG}.md`) : '';

/** Materialize a single command whose body is `document`. */
async function materialize(document: string): Promise<void> {
	await materializeArtifacts('command', CONTEXT, {
		enabled: [{ slug: SLUG, name: 'Fixture', description: 'sync test', document }],
		managedSlugs: [SLUG]
	});
}

afterAll(async () => {
	if (targetFile) await rm(targetFile, { force: true });
});

describe('materializeArtifacts', () => {
	test('an unchanged artifact is not rewritten', async () => {
		expect(targetDir).toBeTruthy();

		await materialize('# Fixture\n\noriginal body\n');
		const firstWrite = (await stat(targetFile)).mtimeMs;

		// Space the calls out: two writes inside the same millisecond would pass
		// this assertion even if the file had genuinely been rewritten.
		await Bun.sleep(20);
		await materialize('# Fixture\n\noriginal body\n');

		expect((await stat(targetFile)).mtimeMs).toBe(firstWrite);
	});

	test('a changed artifact is written', async () => {
		await materialize('# Fixture\n\noriginal body\n');
		const firstWrite = (await stat(targetFile)).mtimeMs;

		await Bun.sleep(20);
		await materialize('# Fixture\n\nedited body\n');

		expect((await stat(targetFile)).mtimeMs).toBeGreaterThan(firstWrite);
		expect(await readFile(targetFile, 'utf8')).toContain('edited body');
	});
});
