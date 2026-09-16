/**
 * Detect on-disk skills (managed effective copies + adoptable real ones) for the
 * Settings UI — the same "detect & link" surface Subagents already had, which
 * Skills never got despite being the feature most likely to already exist on a
 * developer's machine (`~/.claude/skills`, `~/.qwen/skills`, …).
 *
 * Global scope only for now — project scope is surfaced by the per-project
 * detection path when a project is supplied.
 */

import { detectArtifacts, ARTIFACT_ENGINES, type DetectedArtifact, type ArtifactEngine } from '$backend/artifacts';

export interface DetectedSkillGroup {
	engine: ArtifactEngine;
	detected: DetectedArtifact[];
}

/** Detect skills across all engines for the given scope. */
export async function detectSkills(projectPath?: string): Promise<DetectedSkillGroup[]> {
	const scope = projectPath ? 'project' : 'global';
	const groups = await Promise.all(
		ARTIFACT_ENGINES.map(async engine => ({
			engine,
			detected: await detectArtifacts('skill', { engine, scope, projectPath })
		}))
	);
	return groups.filter(g => g.detected.length > 0);
}
