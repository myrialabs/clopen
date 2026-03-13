/**
 * Settings Modal Store - Svelte 5 Runes
 * Controls the visibility and active section of the settings modal
 */

import type { IconName } from '$shared/types/ui/icons';

export type SettingsSection =
	| 'assistant'
	| 'commit-message'
	| 'engines'
	| 'appearance'
	| 'notifications'
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
		id: 'assistant',
		label: 'Assistant',
		icon: 'lucide:cpu',
		description: 'Engine and model for AI assistant'
	},
	{
		id: 'commit-message',
		label: 'Commit Message',
		icon: 'lucide:sparkles',
		description: 'Generate commit messages from staged changes'
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
		label: 'Account',
		icon: 'lucide:user',
		description: 'Your profile and access'
	},
	{
		id: 'engines',
		label: 'AI Engine',
		icon: 'lucide:bot',
		description: 'Installation and accounts',
		adminOnly: true
	},
	{
		id: 'team',
		label: 'Team',
		icon: 'lucide:users',
		description: 'Users and invites',
		adminOnly: true
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
	}
];

// Create the state using Svelte 5 runes
export const settingsModalState = $state<SettingsModalState>({
	isOpen: false,
	activeSection: 'assistant'
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
