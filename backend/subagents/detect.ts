/**
 * Detect on-disk subagents (managed effective copies + adoptable real ones) for
 * the Settings UI.
 */

import { detectArtifacts, type DetectedArtifact, type ArtifactEngine } from '$backend/artifacts';

export interface DetectedSubagentGroup {
	engine: ArtifactEngine;
	detected: DetectedArtifact[];
}

export async function detectSubagents(projectPath?: string): Promise<DetectedSubagentGroup[]> {
	const engines: ArtifactEngine[] = ['claude', 'codex', 'copilot', 'qwen', 'opencode', 'pi'];
	const scope = projectPath ? 'project' : 'global';
	const groups = await Promise.all(
		engines.map(async engine => ({
			engine,
			detected: await detectArtifacts('subagent', { engine, scope, projectPath })
		}))
	);
	return groups.filter(g => g.detected.length > 0);
}
