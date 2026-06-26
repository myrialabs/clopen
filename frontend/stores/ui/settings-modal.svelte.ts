/**
 * Settings Modal Store - Svelte 5 Runes
 * Controls the visibility and active section of the settings modal
 */

import type { IconName } from '$shared/types/ui/icons';
import type { EngineType } from '$shared/types/unified';

export type SettingsSection =
	| 'models'
	| 'engines'
	| 'system-tools'
	| 'mcp'
	| 'skills'
	| 'appearance'
	| 'notifications'
	| 'tunnel'
	| 'account'
	| 'team'
	| 'security'
	| 'system';

/** Sidebar grouping. Sections are rendered under their group header. */
export type SettingsGroup =
	| 'assistant'
	| 'extensions'
	| 'general'
	| 'account'
	| 'administration';

/** Ordered group definitions for the settings sidebar. */
export const settingsGroups: { id: SettingsGroup; label: string }[] = [
	{ id: 'assistant', label: 'Assistant' },
	{ id: 'extensions', label: 'Tools & Extensions' },
	{ id: 'general', label: 'General' },
	{ id: 'account', label: 'Account' },
	{ id: 'administration', label: 'Administration' }
];

interface SettingsModalState {
	isOpen: boolean;
	activeSection: SettingsSection;
	/**
	 * Engine to focus when the Engines section is shown. Set by callers that
	 * deep-link into a specific engine sub-tab (e.g. EngineModelPicker's
	 * "Go to Engines" CTA); AIEnginesSettings consumes and clears it.
	 */
	engineFocus: EngineType | null;
}

// Settings sections metadata
export interface SettingsSectionMeta {
	id: SettingsSection;
	label: string;
	icon: IconName;
	description: string;
	group: SettingsGroup;
	adminOnly?: boolean;
}

export const settingsSections: SettingsSectionMeta[] = [
	{
		id: 'models',
		label: 'Models',
		icon: 'lucide:sparkles',
		description: 'Chat and commit model',
		group: 'assistant'
	},
	{
		id: 'engines',
		label: 'Engines',
		icon: 'lucide:plug',
		description: 'Accounts and providers',
		group: 'extensions',
		adminOnly: true
	},
	{
		id: 'mcp',
		label: 'MCP Servers',
		icon: 'lucide:blocks',
		description: 'Connect external tools',
		group: 'extensions',
		adminOnly: true
	},
	{
		id: 'skills',
		label: 'Skills',
		icon: 'lucide:graduation-cap',
		description: 'Reusable agent instructions',
		group: 'extensions',
		adminOnly: true
	},
	{
		id: 'system-tools',
		label: 'System Tools',
		icon: 'lucide:hammer',
		description: 'Server-side binaries',
		group: 'extensions',
		adminOnly: true
	},
	{
		id: 'appearance',
		label: 'Appearance',
		icon: 'lucide:palette',
		description: 'Theme and layout',
		group: 'general'
	},
	{
		id: 'notifications',
		label: 'Notifications',
		icon: 'lucide:bell',
		description: 'Sound and push notifications',
		group: 'general'
	},
	{
		id: 'tunnel',
		label: 'Tunnel',
		icon: 'lucide:globe',
		description: 'Cloudflare tunnel services',
		group: 'general',
		adminOnly: true
	},
	{
		id: 'account',
		label: 'User Profile',
		icon: 'lucide:user',
		description: 'Your profile and access',
		group: 'account'
	},
	{
		id: 'team',
		label: 'Team',
		icon: 'lucide:users',
		description: 'Users and invites',
		group: 'administration',
		adminOnly: true
	},
	{
		id: 'security',
		label: 'Security',
		icon: 'lucide:shield',
		description: 'Login and access control',
		group: 'administration',
		adminOnly: true
	},
	{
		id: 'system',
		label: 'Maintenance',
		icon: 'lucide:settings-2',
		description: 'Updates and data',
		group: 'administration',
		adminOnly: true
	}
];

// Create the state using Svelte 5 runes
export const settingsModalState = $state<SettingsModalState>({
	isOpen: false,
	activeSection: 'models',
	engineFocus: null
});

// Helper functions
export function openSettingsModal(section: SettingsSection = 'models') {
	settingsModalState.isOpen = true;
	settingsModalState.activeSection = section;
}

export function closeSettingsModal() {
	settingsModalState.isOpen = false;
}

export function setActiveSection(section: SettingsSection) {
	settingsModalState.activeSection = section;
}

export function toggleSettingsModal() {
	settingsModalState.isOpen = !settingsModalState.isOpen;
}

/** Switch to the Engines section and request a specific engine sub-tab. */
export function focusEngineSection(engine: EngineType) {
	settingsModalState.activeSection = 'engines';
	settingsModalState.engineFocus = engine;
}

/** Called by AIEnginesSettings after consuming the focus request. */
export function clearEngineFocus() {
	settingsModalState.engineFocus = null;
}
