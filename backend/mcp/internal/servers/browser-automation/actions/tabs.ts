/**
 * Tab and viewport actions.
 *
 * All of these can change which tab subsequent actions target, so each one
 * calls `ctx.invalidateTab()` — without it a batch like
 * `[open_tab, navigate, screenshot]` would open a tab and then keep driving the
 * old one.
 *
 * Everything here except `set_viewport` is `needsTab: false`: these are the
 * actions an empty browser has to be able to run, so they must not be gated on
 * a tab already existing.
 */

import { z } from 'zod';
import { browserMcpControl } from '$backend/preview';
import { debug } from '$shared/utils/logger';
import type { ActionDef, TablessActionContext } from './types';
import { commonFields } from './shared';
import {
	DEVICE_MODEL_IDS,
	DEVICE_PRESETS,
	DEVICE_SIZES,
	VIEWPORT_LIMITS,
	canRotate,
	defaultRotation,
	getDeviceEmulation,
	getDevicePreset,
	type DeviceSize
} from '$shared/constants/preview';
import type { BrowserTab } from '$backend/preview/browser/types';
import type { EmulationPatch } from '$backend/preview/browser/viewport';

const ROTATIONS = ['portrait', 'landscape'] as const;

const DEVICE_DOC = `device: a model — ${DEVICE_MODEL_IDS.join(' · ')} — sets its class, size, mockup and emulation (list_devices for sizes).
  deviceSize: desktop · laptop (default) · tablet · mobile · responsive (no mockup, any size); picks the class's default model.
  width+height (${VIEWPORT_LIMITS.min}–${VIEWPORT_LIMITS.max}) set an exact size on the current model and decide the orientation themselves.
  touch, mobile (true/false/"auto"): touch events and the mobile viewport (<meta viewport>, overlay scrollbars) — on for tablet/mobile by default; changing either reloads the page.
  colorScheme ("light"/"dark"/"auto"), reducedMotion ("reduce"/"no-preference"/"auto"): emulated media features.`;

const sizeField = (what: string) =>
	z.number().int().min(VIEWPORT_LIMITS.min).max(VIEWPORT_LIMITS.max).optional().describe(`Exact viewport ${what} in CSS pixels. Give with the other dimension.`);

/** Device settings shared by open_tab and set_viewport. */
const deviceFields = {
	device: z.enum(DEVICE_MODEL_IDS).optional().describe('Device model id.'),
	deviceSize: z.enum(DEVICE_SIZES).optional().describe('Device class; its default model.'),
	rotation: z.enum(ROTATIONS).optional().describe('Orientation.'),
	width: sizeField('width'),
	height: sizeField('height'),
	touch: z.union([z.boolean(), z.literal('auto')]).optional().describe('Touch input; "auto" = device default.'),
	mobile: z.union([z.boolean(), z.literal('auto')]).optional().describe('Mobile viewport; "auto" = device default.'),
	colorScheme: z.enum(['light', 'dark', 'auto']).optional().describe('prefers-color-scheme.'),
	reducedMotion: z.enum(['reduce', 'no-preference', 'auto']).optional().describe('prefers-reduced-motion.')
};

interface DeviceArgs {
	device?: string;
	deviceSize?: DeviceSize;
	rotation?: 'portrait' | 'landscape';
	width?: number;
	height?: number;
	touch?: boolean | 'auto';
	mobile?: boolean | 'auto';
	colorScheme?: 'light' | 'dark' | 'auto';
	reducedMotion?: 'reduce' | 'no-preference' | 'auto';
}

/** An exact size only counts when both halves of it were given. */
function exactSize(args: DeviceArgs) {
	if ((args.width === undefined) !== (args.height === undefined)) {
		throw new Error('width and height go together — give both, or neither');
	}
	return args.width && args.height ? { width: args.width, height: args.height } : null;
}

/** The class a request names, checking a model and a class do not disagree. */
function requestedClass(args: DeviceArgs): DeviceSize | undefined {
	const preset = getDevicePreset(args.device);
	if (args.device && !preset) throw new Error(`Unknown device '${args.device}' — see list_devices`);
	if (preset && args.deviceSize && args.deviceSize !== preset.deviceSize) {
		throw new Error(`'${args.device}' is a ${preset.deviceSize}, not a ${args.deviceSize}`);
	}
	return preset?.deviceSize ?? args.deviceSize;
}

/** A laptop's screen is hinged to its keyboard; it cannot stand up. */
function checkRotation(deviceSize: DeviceSize, args: DeviceArgs) {
	const portraitSize = args.width && args.height && args.height > args.width;
	if (!canRotate(deviceSize) && (args.rotation === 'portrait' || portraitSize)) {
		throw new Error(`a ${deviceSize} cannot be portrait — use a monitor (desktop), a tablet, or responsive for a tall viewport`);
	}
}

/** "auto" hands a setting back to the device; absent leaves it alone. */
function emulationPatch(args: DeviceArgs): EmulationPatch {
	const auto = <T>(value: T | 'auto' | undefined): T | null | undefined => (value === 'auto' ? null : value);
	return {
		touch: auto(args.touch),
		mobile: auto(args.mobile),
		colorScheme: auto(args.colorScheme),
		reducedMotion: auto(args.reducedMotion)
	};
}

/** One line describing everything about a tab's device. */
function describeDevice(tab: BrowserTab): string {
	const model = getDevicePreset(tab.deviceModel)?.label ?? tab.deviceSize;
	const { isMobile, hasTouch } = getDeviceEmulation(tab.deviceSize, tab.emulation);
	const settings = [
		hasTouch ? 'touch' : 'no touch',
		isMobile ? 'mobile viewport' : 'desktop viewport',
		tab.emulation.colorScheme && `color-scheme ${tab.emulation.colorScheme}`,
		tab.emulation.reducedMotion && `reduced-motion ${tab.emulation.reducedMotion}`
	].filter(Boolean);
	return `${model} ${tab.rotation} ${tab.viewport.width}×${tab.viewport.height} · ${settings.join(', ')}`;
}

export const listTabs: ActionDef = {
	type: 'list_tabs',
	kind: 'control',
	activity: 'Checking tabs',
	doc: `list_tabs {} — every open tab with its id, URL, device and who controls it.
  Use the id, not the position, with switch_tab/close_tab.`,
	schema: z.object({ type: z.literal('list_tabs'), ...commonFields }),
	needsTab: false,
	run: async (_args, ctx: TablessActionContext) => {
		const tabs = ctx.service.getAllTabs();
		if (tabs.length === 0) return { summary: 'no tabs open' };

		const lines = tabs.map((tab, index) => {
			const owner = browserMcpControl.getTabOwner(tab.id);
			const control = owner ? (owner === ctx.chatSessionId ? ' [yours]' : ' [another session]') : '';
			const opener =
				tab.openedBy?.kind === 'agent'
					? tab.openedBy.chatSessionId === ctx.chatSessionId
						? ' [opened by you]'
						: ' [opened by another chat]'
					: ' [opened by the user]';
			return [
				`${index + 1}. ${tab.isActive ? '*' : ' '} ${tab.id}${control}${opener} — ${tab.title || 'Untitled'}`,
				`     ${tab.url || '(empty)'}`,
				`     ${describeDevice(tab)}${tab.isLoading ? ' · loading' : ''}`
			].join('\n');
		});

		return { summary: `${tabs.length} tab(s)`, detail: lines.join('\n') };
	}
};

export const openTab: ActionDef = {
	type: 'open_tab',
	kind: 'control',
	activity: 'Opening a tab',
	doc: `open_tab {url?, device?, deviceSize?, rotation?, width?, height?, touch?, mobile?, colorScheme?, reducedMotion?} — open a tab and make it the target.
  Device settings as for set_viewport. rotation defaults to the device's natural one.`,
	schema: z.object({
		type: z.literal('open_tab'),
		url: z.string().url().optional().describe('URL to load, including protocol. Omit for a blank tab.'),
		...deviceFields,
		...commonFields
	}),
	needsTab: false,
	run: async (args, ctx: TablessActionContext) => {
		const deviceSize = requestedClass(args) ?? 'laptop';
		checkRotation(deviceSize, args);
		const rotation = args.rotation || defaultRotation(deviceSize);

		const tab = await ctx.service.createTab(args.url || undefined, deviceSize, rotation, undefined, exactSize(args), {
			deviceModel: args.device,
			emulation: emulationPatch(args)
		});
		tab.openedBy = { kind: 'agent', chatSessionId: ctx.chatSessionId };
		browserMcpControl.acquireControl(tab.id, ctx.chatSessionId, ctx.projectId);
		ctx.invalidateTab();

		const device = describeDevice(tab);
		debug.log('mcp', `📑 Opened tab ${tab.id} (${device})`);
		return { summary: `${tab.id} · ${tab.url || '(blank)'} · ${device}` };
	}
};

export const switchTab: ActionDef = {
	type: 'switch_tab',
	kind: 'control',
	activity: 'Switching tab',
	doc: `switch_tab {tabId} — make another tab the target of following actions.`,
	schema: z.object({
		type: z.literal('switch_tab'),
		tabId: z.string().min(1).describe('Tab id from list_tabs.'),
		...commonFields
	}),
	needsTab: false,
	run: async (args, ctx: TablessActionContext) => {
		if (!ctx.service.switchTab(args.tabId)) throw new Error(`Tab '${args.tabId}' not found`);

		const tab = ctx.service.getTab(args.tabId);
		if (tab) {
			const acquired = browserMcpControl.acquireControl(tab.id, ctx.chatSessionId, ctx.projectId);
			if (!acquired) {
				if (!browserMcpControl.isSessionLive(ctx.chatSessionId)) {
					throw new Error('This chat session is no longer running — the browser was released when it stopped.');
				}
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
	activity: 'Closing a tab',
	doc: `close_tab {tabId?} — close a tab (default: the current one).
  Close every tab you opened once you are done with it. Keep one open only if this chat will use it again, it is waiting on the user (a login, an OTP, a captcha), or the user asked for it. Never close a tab the user opened unless asked.`,
	schema: z.object({
		type: z.literal('close_tab'),
		tabId: z.string().optional().describe('Tab id from list_tabs. Omit to close the current tab.'),
		...commonFields
	}),
	// Closing is the one thing an empty browser cannot do — and opening a tab
	// just to close it would be a strange way to find that out.
	needsTab: false,
	run: async (args, ctx: TablessActionContext) => {
		const tabId = args.tabId || ctx.tab?.id;
		if (!tabId) throw new Error('No open tab to close');
		const result = await ctx.service.closeTab(tabId);
		if (!result.success) throw new Error(`Tab '${tabId}' not found`);

		ctx.invalidateTab();

		if (!result.newActiveTabId) return { summary: `${tabId} closed · no tabs left` };
		const next = ctx.service.getTab(result.newActiveTabId);
		return { summary: `${tabId} closed · now on ${result.newActiveTabId} (${next?.url || 'empty'})` };
	}
};

export const listDevices: ActionDef = {
	type: 'list_devices',
	kind: 'control',
	activity: 'Checking devices',
	doc: `list_devices {} — every device model with its class, system and size, and the current tab's device settings.`,
	schema: z.object({ type: z.literal('list_devices'), ...commonFields }),
	needsTab: false,
	run: async (_args, ctx: TablessActionContext) => {
		const lines = DEVICE_PRESETS.map(
			(preset) => `${preset.id} — ${preset.label} · ${preset.deviceSize} · ${preset.os} · ${preset.width}×${preset.height}`
		);
		lines.push('responsive — no mockup, any size (width/height)');

		const active = ctx.service.getActiveTab();
		if (active) lines.push('', `current tab ${active.id}: ${describeDevice(active)}`);

		return { summary: `${DEVICE_PRESETS.length} device models`, detail: lines.join('\n') };
	}
};

export const setViewport: ActionDef = {
	type: 'set_viewport',
	kind: 'control',
	activity: 'Changing the device',
	doc: `set_viewport {device?, deviceSize?, rotation?, width?, height?, touch?, mobile?, colorScheme?, reducedMotion?} — change the current tab's device; anything left out stays as it is.
  ${DEVICE_DOC}
  rotation alone turns the current size around; laptops stay landscape. Any of this re-runs the page's media queries, so it is how responsive layouts get tested.`,
	schema: z.object({
		type: z.literal('set_viewport'),
		...deviceFields,
		...commonFields
	}),
	run: async (args, ctx) => {
		const deviceSize = requestedClass(args) ?? ctx.tab.deviceSize;
		checkRotation(deviceSize, args);

		const ok = await ctx.service.setViewport(ctx.tab.id, {
			deviceSize,
			rotation: args.rotation,
			size: exactSize(args),
			deviceModel: args.device,
			emulation: emulationPatch(args)
		});
		if (!ok) throw new Error(`Could not change the device of tab '${ctx.tab.id}'`);

		const tab = ctx.service.getTab(ctx.tab.id) ?? ctx.tab;
		return { summary: describeDevice(tab) };
	}
};

export const tabActions: ActionDef[] = [listTabs, openTab, switchTab, closeTab, listDevices, setViewport];
