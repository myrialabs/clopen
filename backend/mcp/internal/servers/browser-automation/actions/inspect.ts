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
import {
	DEFAULT_JPEG_QUALITY,
	type CapturedScreenshot,
	type ScreenshotTarget
} from '$backend/preview/browser/browser-screenshot';
import { gitIgnoreState } from '$backend/preview/browser/screenshot-files';
import type { FrameSpec } from '$shared/utils/device-frame';

export const find: ActionDef = {
	type: 'find',
	kind: 'control',
	activity: 'Looking for an element',
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
	activity: 'Reading the page',
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

const DEVICES = ['mobile', 'tablet', 'laptop', 'desktop'] as const;

/** `shots/home.png` → `shots/home-mobile.png`, one file per device. */
function perDevicePath(saveTo: string, device: string, extension: string): string {
	const dot = saveTo.lastIndexOf('.');
	const stem = dot > saveTo.lastIndexOf('/') ? saveTo.slice(0, dot) : saveTo;
	return `${stem}-${device}.${extension}`;
}

export const screenshot: ActionDef = {
	type: 'screenshot',
	kind: 'control',
	activity: 'Taking a screenshot',
	doc: `screenshot {fullPage?, selector?, point?, region?, devices?, deviceFrame?, format?, quality?, saveTo?, return?} — capture the page.
  Needed for what the DOM cannot express: canvases, charts, iframes, captchas, and any visual check of layout or styling.
  What to capture — at most one of: fullPage (whole scrollable page), selector (one element), point {x,y,depth?} (the element under a viewport point, depth ancestors up), region {x,y,width,height} (a viewport rectangle), devices (the page laid out on each listed device — mobile, tablet, laptop, desktop — in a hidden page, without touching the tab). Default: the visible viewport.
  deviceFrame draws the device mockup around a viewport or devices capture, as the user's preview shows it.
  saveTo writes a file under the project directory (with devices, one file per device: name-mobile.png …); with return:"file" the image is not sent back at all, which is what makes "capture twenty pages" affordable.
  format:"jpeg" with quality is much smaller than the default PNG when only the gist matters.`,
	schema: z.object({
		type: z.literal('screenshot'),
		fullPage: z.boolean().optional().describe('Capture the whole scrollable page instead of the viewport.'),
		selector: z.string().optional().describe('Capture just this element.'),
		point: z
			.object({
				x: z.number(),
				y: z.number(),
				depth: z.number().int().min(0).optional().describe('Ancestors to step up from the innermost element (default 0).')
			})
			.optional()
			.describe('Capture the element under this viewport point.'),
		region: z
			.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
			.optional()
			.describe('Capture this rectangle of the viewport, in CSS pixels.'),
		devices: z
			.array(z.enum(DEVICES))
			.min(1)
			.max(4)
			.optional()
			.describe('Capture the page as laid out on each of these devices.'),
		deviceFrame: z.boolean().optional().describe('Draw the device mockup around a viewport or devices capture.'),
		format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png).'),
		quality: z.number().int().min(1).max(100).optional().describe('JPEG quality (default: 80). Ignored for PNG.'),
		saveTo: z.string().optional().describe('Project-relative path to write the image to.'),
		return: z.enum(['inline', 'file', 'both']).optional().describe('inline (default) sends the image back; file only writes it; both does both.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const format = args.format ?? 'png';
		const options = { format, quality: args.quality ?? DEFAULT_JPEG_QUALITY } as const;
		const mode = args.return ?? (args.saveTo ? 'both' : 'inline');

		if (mode !== 'inline' && !args.saveTo) throw new Error('return:"file"/"both" needs saveTo');

		const targets = [args.fullPage, args.selector, args.point, args.region, args.devices].filter((value) => value !== undefined && value !== false);
		if (targets.length > 1) throw new Error('Use at most one of fullPage, selector, point, region and devices');
		if (args.deviceFrame && (args.fullPage || args.selector || args.point || args.region)) {
			throw new Error('deviceFrame only applies to a viewport or devices capture — the frame holds a whole screen');
		}

		// Each capture with what it is called and the device it can be framed in.
		let shots: Array<{ image: CapturedScreenshot; label: string; device?: string; spec: FrameSpec | null }>;

		if (args.devices) {
			// The tab's own colours are the best guess for how the page frames on another device.
			const pageColors = ctx.service.screenshotFrameSpec(ctx.tab.id)?.pageColors;
			const taken = await ctx.service.takeResponsiveScreenshots(ctx.tab.id, [...args.devices], args.deviceFrame ? { format: 'png' } : options);
			shots = taken.map((shot) => ({
				image: shot.image,
				label: `${shot.deviceSize} (${shot.viewport.width}×${shot.viewport.height})`,
				device: shot.deviceSize,
				spec: { deviceSize: shot.deviceSize, viewport: shot.viewport, deviceModel: shot.deviceModel, pageColors }
			}));
		} else {
			// The same capture the viewer's screenshot button uses, so every viewer
			// of the tab sees the shutter when the agent takes one too.
			const target: ScreenshotTarget = args.selector
				? { kind: 'selector', selector: args.selector }
				: args.point
					? { kind: 'element', x: args.point.x, y: args.point.y, depth: args.point.depth }
					: args.region
						? { kind: 'region', ...args.region }
						: args.fullPage
							? { kind: 'fullPage' }
							: { kind: 'viewport' };
			const image = await ctx.service.takeScreenshot(ctx.tab.id, target, args.deviceFrame ? { format: 'png' } : options, 'agent');
			const label = args.selector
				? `screenshot of ${args.selector}`
				: args.point
					? 'screenshot of the element at the point'
					: args.region
						? 'screenshot of the region'
						: 'screenshot';
			shots = [{ image, label, spec: ctx.service.screenshotFrameSpec(ctx.tab.id) }];
		}

		if (args.deviceFrame) {
			// Captured lossless above; the format asked for is applied once, after framing.
			const framed = await ctx.service.frameScreenshots(
				shots.map((shot) => {
					if (!shot.spec) throw new Error('That tab is no longer open');
					return { image: shot.image, spec: shot.spec };
				}),
				options
			);
			shots = shots.map((shot, index) => ({ ...shot, image: framed[index], label: `${shot.label}, framed` }));
		}

		const parts: string[] = [];
		const root = args.saveTo ? projectQueries.getById(ctx.projectId)?.path : undefined;
		let tracked = 0;

		for (const shot of shots) {
			const { image } = shot;
			const line = `${shot.device ? `${shot.device}: ` : ''}${format}, ${image.width}×${image.height}, ${Math.round(image.data.byteLength / 1024)}KB`;
			if (!args.saveTo) {
				parts.push(line);
				continue;
			}
			const target = shot.device ? perDevicePath(args.saveTo, shot.device, format === 'jpeg' ? 'jpg' : 'png') : args.saveTo;
			const absolute = await resolveWritePath(target, ctx.projectId);
			await writeFile(absolute, image.data);
			if (root && (await gitIgnoreState(root, absolute)) === 'not-ignored') tracked += 1;
			parts.push(`${line} saved to ${root ? relative(root, absolute) : absolute}`);
		}
		if (args.fullPage) parts[0] += ', full page';
		if (tracked > 0) {
			parts.push(`git will track ${tracked === 1 ? 'this file' : 'these files'} — keep screenshots in an ignored folder unless they belong in the repository`);
		}

		return {
			summary: parts.join(' · '),
			images:
				mode === 'file'
					? undefined
					: shots.map((shot) => ({
							data: Buffer.from(shot.image.data).toString('base64'),
							mimeType: shot.image.mimeType,
							label: shot.label
						}))
		};
	}
};

export const inspectActions: ActionDef[] = [find, analyzeDom, screenshot];
