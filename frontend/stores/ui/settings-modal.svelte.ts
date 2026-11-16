/**
 * Settings Modal Store - Svelte 5 Runes
 * Controls the visibility and active section of the settings modal.
 *
 * Settings holds how Clopen behaves. What the owner BUILDS — skills, scripts,
 * specialists, rules, toolsets, integrations, secrets — lives in the Library
 * (`library-modal.svelte.ts`), not here.
 */

import type { IconName } from '$shared/types/ui/icons';
import type { EngineType } from '$shared/types/unified';

export type SettingsSection =
	| 'clopen'
	| 'agents'
	| 'models'
	| 'memory'
	| 'permissions'
	| 'git'
	| 'files'
	| 'file-shares'
	| 'devices'
	| 'tunnel'
	| 'messaging'
	| 'appearance'
	| 'notifications'
	| 'machine'
	| 'maintenance';

/** Sidebar grouping. Sections are rendered under their group header. */
export type SettingsGroup = 'clopen' | 'ai' | 'workspace' | 'devices' | 'general' | 'system';

/** Ordered group definitions for the settings sidebar. */
export const settingsGroups: { id: SettingsGroup; label: string }[] = [
	{ id: 'clopen', label: 'Clopen' },
	{ id: 'ai', label: 'AI' },
	{ id: 'workspace', label: 'Workspace' },
	{ id: 'devices', label: 'Devices & Sharing' },
	{ id: 'general', label: 'General' },
	{ id: 'system', label: 'System' }
];

/** Which half of the Agents section is showing. */
export type AgentsTab = 'accounts' | 'install';

interface SettingsModalState {
	isOpen: boolean;
	activeSection: SettingsSection;
	agentsTab: AgentsTab;
	/**
	 * Agent to focus when the Agents section is shown. Set by callers that
	 * deep-link into a specific agent (e.g. the model picker's "Connect an
	 * account" CTA); AIEnginesSettings consumes and clears it.
	 */
	engineFocus: EngineType | null;
	/** The job whose row Models opens with (a link from another menu); the row consumes and clears it. */
	modelsFocus: string | null;
}

// Settings sections metadata
export interface SettingsSectionMeta {
	id: SettingsSection;
	label: string;
	icon: IconName;
	description: string;
	group: SettingsGroup;
}

export const settingsSections: SettingsSectionMeta[] = [
	{
		id: 'clopen',
		label: 'Clopen',
		icon: 'lucide:sparkles',
		description: 'How it acts and starts',
		group: 'clopen'
	},
	{
		id: 'agents',
		label: 'Agents',
		icon: 'lucide:circuit-board',
		// Engines (accounts) and Stack (installs) were two halves of one thing:
		// an agent is usable once it is installed AND signed in.
		description: 'Install and sign in',
		group: 'ai'
	},
	{
		id: 'models',
		label: 'Models',
		icon: 'lucide:bot',
		description: 'Which AI answers',
		group: 'ai'
	},
	{
		id: 'memory',
		label: 'Memory',
		icon: 'lucide:brain',
		description: 'What Clopen remembers',
		group: 'ai'
	},
	{
		id: 'permissions',
		label: 'Permissions',
		icon: 'lucide:shield-check',
		description: 'What agents may use',
		group: 'ai'
	},
	{
		id: 'git',
		label: 'Git',
		icon: 'lucide:git-branch',
		description: 'Commits and accounts',
		group: 'workspace'
	},
	{
		id: 'files',
		label: 'Files & Folders',
		icon: 'lucide:folder-cog',
		description: 'Folders and limits',
		group: 'workspace'
	},
	{
		id: 'file-shares',
		label: 'File Shares',
		icon: 'lucide:link',
		description: 'Links to single files',
		group: 'devices'
	},
	{
		id: 'devices',
		label: 'Devices & Access',
		icon: 'lucide:shield',
		description: 'Who can open Clopen',
		group: 'devices'
	},
	{
		id: 'tunnel',
		label: 'Public Links',
		icon: 'lucide:globe',
		description: 'Share local ports',
		group: 'devices'
	},
	{
		id: 'messaging',
		label: 'Messaging',
		icon: 'lucide:send',
		description: 'Clopen in Telegram',
		group: 'devices'
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
		description: 'Sounds and alerts',
		group: 'general'
	},
	{
		id: 'machine',
		label: 'Machine',
		icon: 'lucide:cpu',
		description: 'This computer',
		group: 'system'
	},
	{
		id: 'maintenance',
		label: 'Maintenance',
		icon: 'lucide:settings-2',
		description: 'Updates and data',
		group: 'system'
	}
];

// Create the state using Svelte 5 runes
export const settingsModalState = $state<SettingsModalState>({
	isOpen: false,
	activeSection: 'clopen',
	agentsTab: 'accounts',
	engineFocus: null,
	modelsFocus: null
});

// Helper functions
export function openSettingsModal(section: SettingsSection = 'clopen') {
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

/** Open Models with one job's row open — where every other menu sends the owner to change a job's model. */
export function openModelsFor(purpose: string) {
	settingsModalState.isOpen = true;
	settingsModalState.activeSection = 'models';
	settingsModalState.modelsFocus = purpose;
}

/** Open Agents on its Install half — where an agent that is not installed yet gets installed. */
export function openAgentsInstall() {
	settingsModalState.isOpen = true;
	settingsModalState.activeSection = 'agents';
	settingsModalState.agentsTab = 'install';
}

/** Switch to the Agents section and request a specific agent's accounts. */
export function focusEngineSection(engine: EngineType) {
	settingsModalState.isOpen = true;
	settingsModalState.activeSection = 'agents';
	settingsModalState.agentsTab = 'accounts';
	settingsModalState.engineFocus = engine;
}

/** Called by AIEnginesSettings after consuming the focus request. */
export function clearEngineFocus() {
	settingsModalState.engineFocus = null;
}
