/**
 * Artifact AI-generation handler (Settings → Skills/Commands/Subagents/Instructions).
 *
 *   - artifacts:generate — draft an artifact of a given type from a purpose
 *     sentence, using the caller-selected engine/model (the "Artifacts" model in
 *     Settings → Models). Returns loosely-typed fields the editor prefills.
 *
 * Admin-gated (authoring is part of the admin artifact editors). The engine/model
 * are chosen client-side, mirroring git:generate-commit-message.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { generateArtifact, type GeneratableType } from '$backend/artifacts';
import type { EngineType } from '$shared/types/unified';
import { requireProjectAccess } from '../access';

export const artifactGenerateHandler = createRouter()
	.http('artifacts:generate', {
		data: t.Object({
			artifactType: t.Union([
				t.Literal('skill'),
				t.Literal('command'),
				t.Literal('subagent'),
				t.Literal('instruction')
			]),
			purpose: t.String(),
			engine: t.String(),
			providerSlug: t.String(),
			modelId: t.String(),
			projectId: t.Optional(t.String())
		}),
		// Loose bag of fields — shape depends on artifactType (see backend/artifacts/generate.ts).
		response: t.Object({ fields: t.Record(t.String(), t.Unknown()) })
	}, async ({ data, conn }) => {
		debug.log('path', `artifacts:generate ${data.artifactType}`);
		if (!data.purpose.trim()) throw new Error('Describe what you want first');

		// Optional project only decides the engine process cwd; generation has no
		// project side effects. Falls back to the Clopen data dir when absent.
		const projectPath = data.projectId ? requireProjectAccess(conn, data.projectId).path : undefined;

		const fields = await generateArtifact(data.artifactType as GeneratableType, data.purpose, {
			engine: data.engine as EngineType,
			providerSlug: data.providerSlug,
			modelId: data.modelId,
			projectPath
		});
		return { fields };
	});
