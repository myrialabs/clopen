/**
 * Settings Modal Store - Svelte 5 Runes
 * Controls the visibility and active section of the settings modal
 */

import type { IconName } from '$shared/types/ui/icons';
import type { EngineType } from '$shared/types/unified';

export type SettingsSection =
	| 'assistant'
	| 'commit-message'
	| 'artifacts'
	| 'engines'
	| 'system-tools'
	| 'mcp'
	| 'skills'
	| 'commands'
	| 'subagents'
	| 'instructions'
	| 'permissions'
	| 'profiles'
	| 'appearance'
	| 'notifications'
	| 'tunnel'
	| 'account'
	| 'team'
	| 'security'
	| 'system';

/** Sidebar grouping. Sections are rendered under their group header. */
export type SettingsGroup =
	| 'models'
	| 'infrastructure'
	| 'artifacts-access'
	| 'preferences'
	| 'administration';

/** Ordered group definitions for the settings sidebar. */
export const settingsGroups: { id: SettingsGroup; label: string }[] = [
	{ id: 'models', label: 'Models' },
	{ id: 'infrastructure', label: 'Infrastructure' },
	{ id: 'artifacts-access', label: 'Artifacts & Access' },
	{ id: 'preferences', label: 'Preferences' },
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
		id: 'assistant',
		label: 'Assistant',
		icon: 'lucide:bot',
		description: 'Chat engine and model',
		group: 'models'
	},
	{
		id: 'commit-message',
		label: 'Git',
		icon: 'lucide:git-branch',
		description: 'Commits and branches',
		group: 'models'
	},
	{
		id: 'artifacts',
		label: 'Artifacts',
		icon: 'lucide:sparkles',
		description: 'Model for extensions',
		group: 'models'
	},
	{
		id: 'engines',
		label: 'Engines',
		icon: 'lucide:circuit-board',
		description: 'Accounts and providers',
		group: 'infrastructure',
		adminOnly: true
	},
	{
		id: 'system-tools',
		label: 'System Tools',
		icon: 'lucide:hammer',
		description: 'Server-side binaries',
		group: 'infrastructure',
		adminOnly: true
	},
	{
		id: 'tunnel',
		label: 'Tunnel',
		icon: 'lucide:globe',
		description: 'Cloudflare tunnel services',
		group: 'infrastructure',
		adminOnly: true
	},
	{
		id: 'mcp',
		label: 'Connectors',
		icon: 'lucide:plug',
		description: 'Connect external tools (MCP)',
		group: 'artifacts-access',
		adminOnly: true
	},
	{
		id: 'skills',
		label: 'Skills',
		icon: 'lucide:graduation-cap',
		description: 'Reusable agent instructions',
		group: 'artifacts-access',
		adminOnly: true
	},
	{
		id: 'commands',
		label: 'Commands',
		icon: 'lucide:terminal',
		description: 'Custom slash commands',
		group: 'artifacts-access',
		adminOnly: true
	},
	{
		id: 'subagents',
		label: 'Subagents',
		icon: 'lucide:bot',
		description: 'Specialized delegated agents',
		group: 'artifacts-access',
		adminOnly: true
	},
	{
		id: 'instructions',
		label: 'Instructions',
		icon: 'lucide:scroll-text',
		description: 'Shared instruction block',
		group: 'artifacts-access',
		adminOnly: true
	},
	{
		id: 'permissions',
		label: 'Permissions',
		icon: 'lucide:shield-check',
		description: 'Per-engine tool allow/deny',
		group: 'artifacts-access',
		adminOnly: true
	},
	{
		id: 'profiles',
		label: 'Profiles',
		icon: 'lucide:layers',
		description: 'Reusable tool bundles',
		group: 'artifacts-access',
		adminOnly: true
	},
	{
		id: 'appearance',
		label: 'Appearance',
		icon: 'lucide:palette',
		description: 'Theme and layout',
		group: 'preferences'
	},
	{
		id: 'notifications',
		label: 'Notifications',
		icon: 'lucide:bell',
		description: 'Sound and push notifications',
		group: 'preferences'
	},
	{
		id: 'account',
		label: 'User Profile',
		icon: 'lucide:user',
		description: 'Your profile and access',
		group: 'preferences'
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
	activeSection: 'assistant',
	engineFocus: null
});

// Helper functions
export function openSettingsModal(section: SettingsSection = 'assistant') {
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
