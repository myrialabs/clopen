/**
 * Bringing a file down from a page onto this machine — an email attachment,
 * an invoice, an export.
 *
 * The browser's own downloads are relayed to whoever is watching the preview;
 * nobody is, when an agent works for Clopen. This keeps the file in the
 * project's `downloads/` folder and says where, so the agent can read it, sign
 * it or send it on — instead of improvising a server or a public tunnel to
 * move it.
 */

import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { findElements } from '$backend/preview/browser/element-locator';
import { projectQueries } from '$backend/database/queries/project-queries';
import type { ActionDef } from './types';
import { commonFields, targetFields } from './shared';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_FETCH_BYTES = 100 * 1024 * 1024;

function downloadsDir(projectId: string): string {
	const root = projectQueries.getById(projectId)?.path;
	if (!root) throw new Error(`Project ${projectId} has no directory on disk`);
	return join(root, 'downloads');
}

function describe(path: string, size: number, projectId: string): { summary: string; detail: string } {
	const root = projectQueries.getById(projectId)?.path;
	return { summary: `saved ${root ? relative(root, path) : path} (${Math.max(1, Math.round(size / 1024))}KB)`, detail: path };
}

export const download: ActionDef = {
	type: 'download',
	kind: 'control',
	activity: 'Downloading a file',
	doc: `download {selector|text|x,y | url, filename?, timeout?} — bring a file down onto this machine and get its path.
  Click the page's download button or link (selector/text/x,y), or give the file's url — fetched with the page's sign-in. Saved in the project's downloads/ folder; the report gives the absolute path to read, attach or send.
  Use this for attachments and exports. Never move a file through a server or a public link of your own.`,
	schema: z.object({
		type: z.literal('download'),
		...targetFields,
		url: z.string().optional().describe('The file to fetch, with the page’s cookies.'),
		filename: z.string().optional().describe('Name to save a fetched url under.'),
		timeout: z.number().optional().describe('Milliseconds to wait for the download (default: 60000).'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const dir = downloadsDir(ctx.projectId);
		const timeout = args.timeout ?? DEFAULT_TIMEOUT_MS;
		const page = ctx.tab.page;

		if (args.url) {
			// Fetched inside the page, so the session cookies that open the attachment come along.
			const fetched = (await page
				.evaluate(
					async (url: string, max: number) => {
						const response = await fetch(url, { credentials: 'include' });
						if (!response.ok) return { error: `HTTP ${response.status}` };
						const blob = await response.blob();
						if (blob.size > max) return { error: 'too large' };
						const disposition = response.headers.get('content-disposition') ?? '';
						const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
						const buffer = new Uint8Array(await blob.arrayBuffer());
						let binary = '';
						for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
						return { data: btoa(binary), name: named ? decodeURIComponent(named) : null, type: blob.type };
					},
					args.url,
					MAX_FETCH_BYTES
				)
				.catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))) as { data?: string; name?: string | null; error?: string };
			if (fetched.data) {
				await mkdir(dir, { recursive: true });
				const name = (args.filename || fetched.name || new URL(args.url, page.url()).pathname.split('/').pop() || 'download').replace(/[\\/:*?"<>|]+/g, '_');
				const path = join(dir, name);
				const bytes = Buffer.from(fetched.data, 'base64');
				await writeFile(path, bytes);
				return describe(path, bytes.byteLength, ctx.projectId);
			}
			// Not fetchable from the page (another site, no CORS): let the browser download it.
			const captured = ctx.service.captureNextDownload(ctx.tab.id, dir, timeout);
			await page.evaluate((url: string) => {
				const link = document.createElement('a');
				link.href = url;
				link.download = '';
				document.body.appendChild(link);
				link.click();
				link.remove();
			}, args.url);
			const file = await captured;
			return describe(file.path, file.size, ctx.projectId);
		}

		if (!args.selector && !args.text && typeof args.x !== 'number') throw new Error('download needs the button to click (selector, text or x,y) or a url');
		let point: { x: number; y: number };
		if (typeof args.x === 'number' && typeof args.y === 'number') {
			point = { x: args.x, y: args.y };
		} else {
			const [match] = await findElements(page, { selector: args.selector, text: args.text, limit: (args.nth ?? 0) + 1 }).then((all) => all.slice(args.nth ?? 0));
			if (!match) throw new Error(`Nothing matched ${args.selector ? `"${args.selector}"` : `the text "${args.text}"`}`);
			point = { x: match.x, y: match.y };
		}
		const captured = ctx.service.captureNextDownload(ctx.tab.id, dir, timeout);
		await page.mouse.click(point.x, point.y);
		const file = await captured;
		return describe(file.path, file.size, ctx.projectId);
	}
};
