/**
 * Reading the page: locating elements, extracting its content, capturing it.
 */

import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { findElements } from '$backend/preview/browser/element-locator';
import { projectQueries } from '$backend/database/queries/project-queries';
import type { ActionDef } from './types';
import { commonFields } from './shared';
import { analyzePage } from './dom-analyze';
import { resolveWritePath } from '../paths';

export const find: ActionDef = {
	type: 'find',
	kind: 'control',
	doc: `find {selector?, text?, role?, limit?} — locate elements and get their positions.
  Returns tag, text, a reusable selector and a centre point for each match, iframes included.
  This is the cheap alternative to a screenshot: to click something you can name, find it and click by selector — no image, no vision, no coordinate guessing.`,
	schema: z.object({
		type: z.literal('find'),
		selector: z.string().optional().describe('CSS selector to match.'),
		text: z.string().optional().describe('Visible text to match, when no selector is known.'),
		role: z.string().optional().describe('Filter by ARIA role or tag (button, link, textbox…).'),
		limit: z.number().int().min(1).max(100).optional().describe('Maximum matches (default: 20).'),
		visibleOnly: z.boolean().optional().describe('Skip hidden elements (default: true).'),
		...commonFields
	}),
	run: async (args, ctx) => {
		if (!args.selector && !args.text && !args.role) {
			throw new Error('find needs one of: selector, text, or role');
		}

		const matches = await findElements(ctx.tab.page, {
			selector: args.selector,
			text: args.text,
			role: args.role,
			limit: args.limit,
			visibleOnly: args.visibleOnly
		});

		if (matches.length === 0) return { summary: 'no matches' };

		const lines = matches.map((m, i) => {
			const bits = [
				`[${i}] <${m.tag}> "${m.text || m.name || m.placeholder || ''}"`,
				`     at (${m.x}, ${m.y}) · ${m.box.width}×${m.box.height}${m.inFrame ? ' · in iframe' : ''}${m.enabled ? '' : ' · disabled'}`,
				`     selector: ${m.selector}`
			];
			if (m.href) bits.push(`     href: ${m.href}`);
			if (m.value) bits.push(`     value: ${m.value}`);
			return bits.join('\n');
		});

		return { summary: `${matches.length} match(es)`, detail: lines.join('\n') };
	}
};

export const analyzeDom: ActionDef = {
	type: 'analyze_dom',
	kind: 'control',
	doc: `analyze_dom {include?} — the page as text: links, headings, content, forms, metadata.
  The primary tool for reading and exploring. Far cheaper than a screenshot and it sees the whole document, not just the part currently on screen — scrolling to "see more" is never necessary.
  include: navigation | structure | content | forms | summary. Omit for all.
  Blind spots: no coordinates, and it cannot see inside iframes (summary.hasIframes tells you when that matters).`,
	schema: z.object({
		type: z.literal('analyze_dom'),
		include: z
			.array(z.enum(['navigation', 'structure', 'content', 'forms', 'summary']))
			.optional()
			.describe('Sections to return. ["navigation","content"] covers most reading tasks.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const analysis = await analyzePage(ctx.tab.page);

		const wanted = args.include ? new Set<string>(args.include) : null;
		const filtered = wanted
			? Object.fromEntries(Object.entries(analysis).filter(([key]) => wanted.has(key)))
			: analysis;

		const linkCount = analysis.navigation.links.length;
		return {
			summary: `${linkCount} link(s), ${analysis.structure.headings.length} heading(s), ${analysis.content.paragraphs.length} text block(s)`,
			detail: JSON.stringify(filtered, null, 2)
		};
	}
};

export const screenshot: ActionDef = {
	type: 'screenshot',
	kind: 'control',
	doc: `screenshot {fullPage?, selector?, format?, quality?, saveTo?, return?} — capture the page.
  Needed for what the DOM cannot express: canvases, charts, iframes, captchas, and any visual check of layout or styling.
  saveTo writes a file under the project directory; with return:"file" the image is not sent back at all, which is what makes "capture twenty pages" affordable.
  format:"jpeg" with quality is much smaller than the default PNG when only the gist matters.`,
	schema: z.object({
		type: z.literal('screenshot'),
		fullPage: z.boolean().optional().describe('Capture the whole scrollable page instead of the viewport.'),
		selector: z.string().optional().describe('Capture just this element.'),
		format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png).'),
		quality: z.number().int().min(1).max(100).optional().describe('JPEG quality (default: 80). Ignored for PNG.'),
		saveTo: z.string().optional().describe('Project-relative path to write the image to.'),
		return: z.enum(['inline', 'file', 'both']).optional().describe('inline (default) sends the image back; file only writes it; both does both.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const format = args.format ?? 'png';
		const mode = args.return ?? (args.saveTo ? 'both' : 'inline');

		if (mode !== 'inline' && !args.saveTo) throw new Error('return:"file"/"both" needs saveTo');

		const options = {
			type: format,
			fullPage: !!args.fullPage,
			...(format === 'jpeg' ? { quality: args.quality ?? 80 } : {})
		} as const;

		let buffer: Uint8Array;
		if (args.selector) {
			const element = await ctx.tab.page.$(args.selector);
			if (!element) throw new Error(`No element matched "${args.selector}"`);
			try {
				buffer = await element.screenshot(options);
			} finally {
				await element.dispose().catch(() => {});
			}
		} else {
			buffer = await ctx.tab.page.screenshot(options);
		}

		const parts: string[] = [`${format}, ${Math.round(buffer.byteLength / 1024)}KB${args.fullPage ? ', full page' : ''}`];

		if (args.saveTo) {
			const absolute = await resolveWritePath(args.saveTo, ctx.projectId);
			await writeFile(absolute, buffer);
			const root = projectQueries.getById(ctx.projectId)?.path;
			parts.push(`saved to ${root ? relative(root, absolute) : absolute}`);
		}

		return {
			summary: parts.join(' · '),
			images:
				mode === 'file'
					? undefined
					: [
							{
								data: Buffer.from(buffer).toString('base64'),
								mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
								label: args.selector ? `screenshot of ${args.selector}` : 'screenshot'
							}
						]
		};
	}
};

export const inspectActions: ActionDef[] = [find, analyzeDom, screenshot];
