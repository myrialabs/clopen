/**
 * Settings Modal Store - Svelte 5 Runes
 * Controls the visibility and active section of the settings modal
 */

import type { IconName } from '$shared/types/ui/icons';

export type SettingsSection =
	| 'model'
	| 'engines'
	| 'appearance'
	| 'user'
	| 'notifications'
	| 'general';

interface SettingsModalState {
	isOpen: boolean;
	activeSection: SettingsSection;
}

// Settings sections metadata
export const settingsSections: Array<{
	id: SettingsSection;
	label: string;
	icon: IconName;
	description: string;
}> = [
	{
		id: 'model',
		label: 'Model',
		icon: 'lucide:cpu',
		description: 'Configure AI engine and model'
	},
	{
		id: 'engines',
		label: 'AI Engine',
		icon: 'lucide:bot',
		description: 'Installation and accounts'
	},
	{
		id: 'appearance',
		label: 'Appearance',
		icon: 'lucide:palette',
		description: 'Theme and layout customization'
	},
	{
		id: 'user',
		label: 'User',
		icon: 'lucide:user',
		description: 'User profile settings'
	},
	{
		id: 'notifications',
		label: 'Notifications',
		icon: 'lucide:bell',
		description: 'Sound and push notifications'
	},
	{
		id: 'general',
		label: 'General',
		icon: 'lucide:settings-2',
		description: 'Data management and security'
	}
];

// Create the state using Svelte 5 runes
export const settingsModalState = $state<SettingsModalState>({
	isOpen: false,
	activeSection: 'model'
});

// Helper functions
export function openSettingsModal(section: SettingsSection = 'model') {
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
