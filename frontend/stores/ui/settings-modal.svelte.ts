/**
 * Settings Modal Store - Svelte 5 Runes
 * Controls the visibility and active section of the settings modal
 */

import type { IconName } from '$shared/types/ui/icons';

export type SettingsSection =
	| 'models'
	| 'engines'
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
		description: 'Installation and accounts',
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
		label: 'System',
		icon: 'lucide:settings-2',
		description: 'Updates and data',
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
	activeSection: 'models'
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
