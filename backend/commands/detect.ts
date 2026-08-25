/**
 * Detect on-disk commands (managed effective copies + adoptable real ones) for
 * the Settings UI. Global scope only for now — project scope is surfaced by the
 * per-project detection path when a project is supplied.
 */

import { detectArtifacts, type DetectedArtifact, type ArtifactEngine } from '$backend/artifacts';

export interface DetectedCommandGroup {
	engine: ArtifactEngine;
	detected: DetectedArtifact[];
}

/** Detect commands across all engines for the given scope. */
export async function detectCommands(projectPath?: string): Promise<DetectedCommandGroup[]> {
	const engines: ArtifactEngine[] = ['claude', 'codex', 'copilot', 'qwen', 'opencode', 'pi'];
	const scope = projectPath ? 'project' : 'global';
	const groups = await Promise.all(
		engines.map(async engine => ({
			engine,
			detected: await detectArtifacts('command', { engine, scope, projectPath })
		}))
	);
	return groups.filter(g => g.detected.length > 0);
}
