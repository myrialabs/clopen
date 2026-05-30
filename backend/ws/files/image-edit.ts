/**
 * Files Image Edit Operation
 *
 * Applies a declarative `ImageEditRecipe` (crop/resize/rotate/flip/filters/
 * compression) to an image on disk with sharp and writes the result either back
 * over the original or to a new copy.
 *
 * The recipe is small JSON and the source is read server-side from disk, so no
 * large binary crosses the wire in either direction — this fits the existing
 * WS-http router rather than the streaming HTTP upload route.
 */

import { t } from 'elysia';
import { stat as fsStat } from 'node:fs/promises';

import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import type { ImageEditRecipe } from '$shared/types/filesystem';
import { processImageEdit } from '../../files/image-processing';
import { requireFilePathAccess } from './path-access';

const cropSchema = t.Object({
	left: t.Number(),
	top: t.Number(),
	width: t.Number(),
	height: t.Number()
});

const recipeSchema = t.Object({
	crop: t.Optional(cropSchema),
	resize: t.Optional(t.Object({ width: t.Number(), height: t.Number() })),
	rotate: t.Optional(
		t.Union([t.Literal(0), t.Literal(90), t.Literal(180), t.Literal(270)])
	),
	flipH: t.Optional(t.Boolean()),
	flipV: t.Optional(t.Boolean()),
	brightness: t.Optional(t.Number()),
	saturation: t.Optional(t.Number()),
	contrast: t.Optional(t.Number()),
	hue: t.Optional(t.Number()),
	blur: t.Optional(t.Number()),
	grayscale: t.Optional(t.Boolean()),
	sepia: t.Optional(t.Boolean()),
	invert: t.Optional(t.Boolean()),
	background: t.Optional(t.String()),
	regions: t.Optional(
		t.Array(
			t.Object({
				type: t.Union([t.Literal('blur'), t.Literal('pixelate')]),
				left: t.Number(),
				top: t.Number(),
				width: t.Number(),
				height: t.Number(),
				strength: t.Number()
			})
		)
	),
	annotations: t.Optional(
		t.Array(
			t.Object({
				color: t.String(),
				size: t.Number(),
				opacity: t.Optional(t.Number()),
				points: t.Array(t.Object({ x: t.Number(), y: t.Number() }))
			})
		)
	),
	output: t.Object({
		format: t.Union([
			t.Literal('png'),
			t.Literal('jpeg'),
			t.Literal('webp'),
			t.Literal('gif'),
			t.Literal('avif')
		]),
		compress: t.Optional(t.Boolean()),
		quality: t.Optional(t.Number()),
		lossless: t.Optional(t.Boolean())
	})
});

export const imageEditHandler = createRouter()
	// Dry-run: apply the recipe and report the resulting byte size without
	// writing anything — drives the editor's live "Result size" readout, so it
	// matches the real save exactly (same codec) instead of a browser estimate.
	.http('files:estimate-image', {
		data: t.Object({
			sourcePath: t.String(),
			recipe: recipeSchema
		}),
		response: t.Object({
			size: t.Number(),
			width: t.Number(),
			height: t.Number()
		})
	}, async ({ data, conn }) => {
		const sourcePath = await requireFilePathAccess(conn, data.sourcePath);
		// Fast mode: lower encoder effort so the live estimate stays responsive
		// on very large images / upscales. The real save uses full effort.
		const result = await processImageEdit(sourcePath, data.recipe as ImageEditRecipe, true);
		return { size: result.size, width: result.width, height: result.height };
	})

	.http('files:edit-image', {
	data: t.Object({
		sourcePath: t.String(),
		targetPath: t.String(),
		// true = write over targetPath even if it exists; false = refuse if it exists.
		overwrite: t.Boolean(),
		recipe: recipeSchema,
		// Optimistic concurrency token: the disk mtime the editor based its
		// source on. Only checked when overwriting an existing file.
		baseModified: t.Optional(t.String())
	}),
	response: t.Object({
		message: t.String(),
		path: t.String(),
		size: t.Number(),
		width: t.Number(),
		height: t.Number(),
		modified: t.String()
	})
}, async ({ data, conn }) => {
	const sourcePath = await requireFilePathAccess(conn, data.sourcePath);
	const targetPath = await requireFilePathAccess(conn, data.targetPath);

	const targetStat = await fsStat(targetPath).catch(() => null);

	if (data.overwrite) {
		// Refuse to clobber a version newer than the one the editor loaded.
		if (targetStat && data.baseModified && targetStat.mtime.toISOString() !== data.baseModified) {
			throw new Error('FILE_CONFLICT: file changed on disk since it was opened in the editor');
		}
	} else if (targetStat) {
		throw new Error('File already exists');
	}

	const recipe = data.recipe as ImageEditRecipe;
	debug.log('file', 'Edit image operation:', {
		sourcePath,
		targetPath,
		overwrite: data.overwrite,
		format: recipe.output.format
	});

	const result = await processImageEdit(sourcePath, recipe);
	await Bun.write(targetPath, result.data);

	const stats = await fsStat(targetPath);
	return {
		message: data.overwrite ? 'Image saved successfully' : 'Image saved as a new file',
		path: targetPath,
		size: result.size,
		width: result.width,
		height: result.height,
		modified: stats.mtime.toISOString()
	};
});
