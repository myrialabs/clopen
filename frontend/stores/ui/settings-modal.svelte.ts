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
	| 'appearance'
	| 'notifications'
	| 'tunnel'
	| 'account'
	| 'team'
	| 'security'
	| 'system';

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
	adminOnly?: boolean;
}

export const settingsSections: SettingsSectionMeta[] = [
	{
		id: 'models',
		label: 'Models',
		icon: 'lucide:sparkles',
		description: 'Chat and commit model'
	},
	{
		id: 'engines',
		label: 'Engines',
		icon: 'lucide:plug',
		description: 'Accounts and providers',
		adminOnly: true
	},
	{
		id: 'tunnel',
		label: 'Tunnel',
		icon: 'lucide:globe',
		description: 'Cloudflare tunnel services'
	},
	{
		id: 'appearance',
		label: 'Appearance',
		icon: 'lucide:palette',
		description: 'Theme and layout'
	},
	{
		id: 'notifications',
		label: 'Notifications',
		icon: 'lucide:bell',
		description: 'Sound and push notifications'
	},
	{
		id: 'account',
		label: 'User Profile',
		icon: 'lucide:user',
		description: 'Your profile and access'
	},
	{
		id: 'security',
		label: 'Security',
		icon: 'lucide:shield',
		description: 'Login and access control',
		adminOnly: true
	},
	{
		id: 'system',
		label: 'Maintenance',
		icon: 'lucide:settings-2',
		description: 'Updates and data',
		adminOnly: true
	},
	{
		id: 'system-tools',
		label: 'System Tools',
		icon: 'lucide:hammer',
		description: 'Server-side binaries',
		adminOnly: true
	},
	{
		id: 'team',
		label: 'Team',
		icon: 'lucide:users',
		description: 'Users and invites',
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
