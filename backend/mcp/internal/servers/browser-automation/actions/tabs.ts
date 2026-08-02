/**
 * Tab and viewport actions.
 *
 * All of these can change which tab subsequent actions target, so each one
 * calls `ctx.invalidateTab()` — without it a batch like
 * `[open_tab, navigate, screenshot]` would open a tab and then keep driving the
 * old one.
 */

import { z } from 'zod';
import { browserMcpControl } from '$backend/preview';
import { debug } from '$shared/utils/logger';
import type { ActionDef } from './types';
import { commonFields } from './shared';

const DEVICE_SIZES = ['desktop', 'laptop', 'tablet', 'mobile'] as const;
const ROTATIONS = ['portrait', 'landscape'] as const;

/** Devices that read as held rather than sat in front of. */
function defaultRotation(deviceSize: string): 'portrait' | 'landscape' {
	return deviceSize === 'desktop' || deviceSize === 'laptop' ? 'landscape' : 'portrait';
}

export const listTabs: ActionDef = {
	type: 'list_tabs',
	kind: 'control',
	doc: `list_tabs {} — every open tab with its id, URL, viewport and who controls it.
  Use the id, not the position, with switch_tab/close_tab.`,
	schema: z.object({ type: z.literal('list_tabs'), ...commonFields }),
	run: async (_args, ctx) => {
		const tabs = ctx.service.getAllTabs();
		if (tabs.length === 0) return { summary: 'no tabs open' };

		const lines = tabs.map((tab, index) => {
			const owner = browserMcpControl.getTabOwner(tab.id);
			const control = owner ? (owner === ctx.chatSessionId ? ' [yours]' : ' [another session]') : '';
			return [
				`${index + 1}. ${tab.isActive ? '*' : ' '} ${tab.id}${control} — ${tab.title || 'Untitled'}`,
				`     ${tab.url || '(empty)'}`,
				`     ${tab.deviceSize}/${tab.rotation}${tab.isLoading ? ' · loading' : ''}`
			].join('\n');
		});

		return { summary: `${tabs.length} tab(s)`, detail: lines.join('\n') };
	}
};

export const openTab: ActionDef = {
	type: 'open_tab',
	kind: 'control',
	doc: `open_tab {url?, deviceSize?, rotation?} — open a tab and make it the target.
  deviceSize: desktop 1920×1080 · laptop 1440×900 (default) · tablet 834×1194 · mobile 402×874.
  rotation defaults to landscape for desktop/laptop, portrait for tablet/mobile.`,
	schema: z.object({
		type: z.literal('open_tab'),
		url: z.string().url().optional().describe('URL to load, including protocol. Omit for a blank tab.'),
		deviceSize: z.enum(DEVICE_SIZES).optional().describe('Viewport preset (default: laptop).'),
		rotation: z.enum(ROTATIONS).optional().describe('Orientation. Omit for the device default.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const deviceSize = args.deviceSize || 'laptop';
		const rotation = args.rotation || defaultRotation(deviceSize);

		const tab = await ctx.service.createTab(args.url || undefined, deviceSize, rotation);
		browserMcpControl.acquireControl(tab.id, ctx.chatSessionId, ctx.projectId);
		ctx.invalidateTab();

		debug.log('mcp', `📑 Opened tab ${tab.id} (${deviceSize}/${rotation})`);
		return { summary: `${tab.id} · ${tab.url || '(blank)'} · ${deviceSize}/${rotation}` };
	}
};

export const switchTab: ActionDef = {
	type: 'switch_tab',
	kind: 'control',
	doc: `switch_tab {tabId} — make another tab the target of following actions.`,
	schema: z.object({
		type: z.literal('switch_tab'),
		tabId: z.string().min(1).describe('Tab id from list_tabs.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		if (!ctx.service.switchTab(args.tabId)) throw new Error(`Tab '${args.tabId}' not found`);

		const tab = ctx.service.getTab(args.tabId);
		if (tab) {
			const acquired = browserMcpControl.acquireControl(tab.id, ctx.chatSessionId, ctx.projectId);
			if (!acquired) {
				const owner = browserMcpControl.getTabOwner(tab.id);
				throw new Error(`Tab '${args.tabId}' is controlled by another chat session (${owner?.slice(0, 8)}...)`);
			}
			// Promote so the tab resolver targets this one next.
			browserMcpControl.promoteSessionTab(tab.id, ctx.chatSessionId);
		}

		ctx.invalidateTab();
		return { summary: `${args.tabId} · ${tab?.url || '(empty)'}` };
	}
};

export const closeTab: ActionDef = {
	type: 'close_tab',
	kind: 'control',
	doc: `close_tab {tabId?} — close a tab (default: the current one).`,
	schema: z.object({
		type: z.literal('close_tab'),
		tabId: z.string().optional().describe('Tab id from list_tabs. Omit to close the current tab.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const tabId = args.tabId || ctx.tab.id;
		const result = await ctx.service.closeTab(tabId);
		if (!result.success) throw new Error(`Tab '${tabId}' not found`);

		ctx.invalidateTab();

		if (!result.newActiveTabId) return { summary: `${tabId} closed · no tabs left` };
		const next = ctx.service.getTab(result.newActiveTabId);
		return { summary: `${tabId} closed · now on ${result.newActiveTabId} (${next?.url || 'empty'})` };
	}
};

export const setViewport: ActionDef = {
	type: 'set_viewport',
	kind: 'control',
	doc: `set_viewport {deviceSize?, rotation?} — resize the current tab.
  Changing this re-runs the page's media queries, so it is how responsive layouts get tested.`,
	schema: z.object({
		type: z.literal('set_viewport'),
		deviceSize: z.enum(DEVICE_SIZES).optional().describe('Omit to keep the current size.'),
		rotation: z.enum(ROTATIONS).optional().describe('Omit to keep the current orientation.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const deviceSize = args.deviceSize || ctx.tab.deviceSize;
		const rotation = args.rotation || ctx.tab.rotation;

		const ok = await ctx.service.setViewport(ctx.tab.id, deviceSize, rotation);
		if (!ok) throw new Error(`Could not resize tab '${ctx.tab.id}'`);

		return { summary: `${deviceSize}/${rotation}` };
	}
};

export const tabActions: ActionDef[] = [listTabs, openTab, switchTab, closeTab, setViewport];
