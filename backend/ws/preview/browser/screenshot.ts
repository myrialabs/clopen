/**
 * Browser Screenshot WebSocket Handler
 *
 * The viewer's screenshot controls: capture a tab (on screen, full page, an
 * area, an element), probe the element under the picker, capture the page at
 * other device sizes, and save a finished image into the workspace.
 *
 * Every capture runs in the tab's own browser — the same path the agent's
 * `screenshot` action takes — so the picture is the page at its real
 * resolution, not a frame of the stream.
 *
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { DEVICE_SIZES } from '$shared/constants/preview';
import { requireProjectWorkspace } from '../../access';
import { requireBrowserPreviewAccess, requireBrowserTabAccess } from '../access';
import { ignoreScreenshotFolder, saveScreenshotFile } from '$backend/preview/browser/screenshot-files';
import type { CapturedScreenshot } from '$backend/preview/browser/browser-screenshot';

const formatSchema = t.Optional(t.Union([t.Literal('png'), t.Literal('jpeg')]));
const qualitySchema = t.Optional(t.Number({ minimum: 1, maximum: 100 }));

const targetSchema = t.Union([
	t.Object({ kind: t.Literal('viewport') }),
	t.Object({ kind: t.Literal('fullPage') }),
	t.Object({
		kind: t.Literal('element'),
		x: t.Number(),
		y: t.Number(),
		depth: t.Optional(t.Number({ minimum: 0 }))
	}),
	t.Object({
		kind: t.Literal('region'),
		x: t.Number(),
		y: t.Number(),
		width: t.Number(),
		height: t.Number()
	})
]);

const imageSchema = t.Object({
	data: t.String(),
	mimeType: t.Union([t.Literal('image/png'), t.Literal('image/jpeg')]),
	width: t.Number(),
	height: t.Number()
});

const deviceSchema = t.Union(
	DEVICE_SIZES.filter((size) => size !== 'responsive').map((size) => t.Literal(size))
);

const gitStateSchema = t.Union([t.Literal('ignored'), t.Literal('not-ignored'), t.Literal('no-repo')]);

function encode(image: CapturedScreenshot) {
	return {
		data: Buffer.from(image.data).toString('base64'),
		mimeType: image.mimeType,
		width: image.width,
		height: image.height
	};
}

export const screenshotPreviewHandler = createRouter()
	.http('preview:browser-screenshot', {
		data: t.Object({
			tabId: t.String({ minLength: 1 }),
			target: targetSchema,
			format: formatSchema,
			quality: qualitySchema
		}),
		response: t.Object({
			image: imageSchema,
			url: t.String(),
			title: t.String()
		})
	}, async ({ data, conn }) => {
		const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);
		const image = await previewService.takeScreenshot(
			tab.id,
			data.target,
			{ format: data.format, quality: data.quality },
			'user'
		);
		debug.log('preview', `📸 Screenshot of ${tab.id} (${data.target.kind}): ${image.width}×${image.height}`);
		return { image: encode(image), url: tab.page.url(), title: tab.title };
	})

	.http('preview:browser-screenshot-element-at', {
		data: t.Object({
			tabId: t.String({ minLength: 1 }),
			x: t.Number(),
			y: t.Number(),
			depth: t.Optional(t.Number({ minimum: 0 }))
		}),
		response: t.Object({
			element: t.Union([
				t.Null(),
				t.Object({
					rect: t.Object({ x: t.Number(), y: t.Number(), width: t.Number(), height: t.Number() }),
					label: t.String(),
					depth: t.Number(),
					hasParent: t.Boolean()
				})
			])
		})
	}, async ({ data, conn }) => {
		const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);
		return { element: await previewService.screenshotElementAt(tab.id, data.x, data.y, data.depth ?? 0) };
	})

	.http('preview:browser-screenshot-responsive', {
		data: t.Object({
			tabId: t.String({ minLength: 1 }),
			devices: t.Array(deviceSchema, { minItems: 1, maxItems: 4 }),
			format: formatSchema,
			quality: qualitySchema
		}),
		response: t.Object({
			url: t.String(),
			title: t.String(),
			shots: t.Array(t.Object({
				deviceSize: t.String(),
				deviceModel: t.Union([t.String(), t.Null()]),
				viewport: t.Object({ width: t.Number(), height: t.Number() }),
				image: imageSchema
			}))
		})
	}, async ({ data, conn }) => {
		const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);
		const shots = await previewService.takeResponsiveScreenshots(tab.id, data.devices, {
			format: data.format,
			quality: data.quality
		});
		return {
			url: tab.page.url(),
			title: tab.title,
			shots: shots.map((shot) => ({ ...shot, image: encode(shot.image) }))
		};
	})

	// Save a finished image — edits and frame already applied by the viewer.
	.http('preview:browser-screenshot-save', {
		data: t.Object({
			fileName: t.String({ minLength: 1 }),
			data: t.String({ minLength: 1 }),
			mimeType: t.Union([t.Literal('image/png'), t.Literal('image/jpeg')]),
			folder: t.Optional(t.String())
		}),
		response: t.Object({
			path: t.String(),
			folder: t.String(),
			git: gitStateSchema
		})
	}, async ({ data, conn }) => {
		const { projectId } = requireBrowserPreviewAccess(conn);
		const { root } = requireProjectWorkspace(conn, projectId);
		const bytes = new Uint8Array(Buffer.from(data.data, 'base64'));
		const saved = await saveScreenshotFile(
			root,
			data.folder,
			data.fileName,
			bytes,
			data.mimeType === 'image/jpeg' ? 'jpg' : 'png'
		);
		debug.log('preview', `💾 Screenshot saved to ${saved.path} (git: ${saved.git})`);
		return saved;
	})

	.http('preview:browser-screenshot-ignore-folder', {
		data: t.Object({
			folder: t.Optional(t.String())
		}),
		response: t.Object({
			git: gitStateSchema
		})
	}, async ({ data, conn }) => {
		const { projectId } = requireBrowserPreviewAccess(conn);
		const { root } = requireProjectWorkspace(conn, projectId);
		return { git: await ignoreScreenshotFolder(root, data.folder) };
	});
