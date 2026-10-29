/**
 * Settings Modal Store - Svelte 5 Runes
 * Controls the visibility and active section of the settings modal
 */

import type { IconName } from '$shared/types/ui/icons';
import type { EngineType } from '$shared/types/unified';

export type SettingsSection =
	| 'assistant'
	| 'commit-message'
	| 'git-identities'
	| 'artifacts'
	| 'engines'
	| 'stack'
	| 'integrations'
	| 'skills'
	| 'subagents'
	| 'instructions'
	| 'permissions'
	| 'file-shares'
	| 'memory'
	| 'memory-graph'
	| 'profiles'
	| 'appearance'
	| 'notifications'
	| 'chat-apps'
	| 'tunnel'
	| 'access'
	| 'files'
	| 'machine'
	| 'system';

/** Sidebar grouping. Sections are rendered under their group header. */
export type SettingsGroup =
	| 'models'
	| 'infrastructure'
	| 'artifacts-access'
	| 'preferences'
	| 'system';

/** Ordered group definitions for the settings sidebar. */
export const settingsGroups: { id: SettingsGroup; label: string }[] = [
	{ id: 'models', label: 'Models' },
	{ id: 'infrastructure', label: 'Infrastructure' },
	{ id: 'artifacts-access', label: 'Artifacts & Access' },
	{ id: 'preferences', label: 'Preferences' },
	{ id: 'system', label: 'System' }
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
	/**
	 * Provider whose Connect dialog should open as soon as Integrations is shown.
	 *
	 * Set by a CTA that already knows what the user is trying to connect — the
	 * Issues & PRs surface's empty state, for one. Sending them to a list and letting
	 * them find Add → GitHub is three clicks of looking for something we already
	 * knew. IntegrationsSettings consumes and clears it.
	 */
	integrationFocusProvider: string | null;
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
		id: 'git-identities',
		label: 'Git Accounts',
		icon: 'lucide:user-round-cog',
		description: 'Commit identity and credentials',
		group: 'infrastructure'
	},
	{
		id: 'artifacts',
		label: 'Artifacts',
		icon: 'lucide:sparkles',
		description: 'Model for extensions',
		group: 'models'
	},
	{
		id: 'memory',
		label: 'Memory',
		icon: 'lucide:brain',
		description: 'Model for long-term memory',
		group: 'models'
	},
	{
		id: 'engines',
		label: 'Engines',
		icon: 'lucide:circuit-board',
		description: 'Accounts and providers',
		group: 'infrastructure'
	},
	{
		id: 'stack',
		label: 'Stack',
		icon: 'lucide:hammer',
		description: 'Engines, runtimes & tools',
		group: 'infrastructure'
	},
	{
		id: 'memory-graph',
		label: 'Memory',
		icon: 'lucide:brain',
		description: 'What gets remembered',
		group: 'infrastructure'
	},
	{
		id: 'tunnel',
		label: 'Tunnel',
		icon: 'lucide:globe',
		description: 'Cloudflare tunnel services',
		group: 'infrastructure'
	},
	{
		id: 'file-shares',
		label: 'File Shares',
		icon: 'lucide:link',
		// Infrastructure, not Artifacts & Access: a share link is a way out of
		// this server, like a tunnel — nothing to do with what an engine can
		// reach.
		description: 'Links that expose a single file',
		group: 'infrastructure'
	},
	{
		id: 'integrations',
		label: 'Integrations',
		icon: 'lucide:plug',
		// Absorbed the old Connectors section: built-in tools, connected accounts
		// and hand-installed MCP servers are one list now, because two places to
		// connect a service means two tokens in two tables.
		description: 'Connected services and tools',
		group: 'artifacts-access'
	},
	{
		id: 'skills',
		label: 'Skills',
		icon: 'lucide:graduation-cap',
		// Absorbed the old Commands section: a slash command is a skill the user
		// invokes by name instead of one the agent picks up, so two menus meant
		// two editors over one artifact.
		description: 'Reusable prompts and /commands',
		group: 'artifacts-access'
	},
	{
		id: 'subagents',
		label: 'Subagents',
		icon: 'lucide:bot',
		description: 'Specialized delegated agents',
		group: 'artifacts-access'
	},
	{
		id: 'instructions',
		label: 'Instructions',
		icon: 'lucide:scroll-text',
		description: 'Shared instruction block',
		group: 'artifacts-access'
	},
	{
		id: 'permissions',
		label: 'Permissions',
		icon: 'lucide:shield-check',
		description: 'Per-engine tool allow/deny',
		group: 'artifacts-access'
	},
	{
		id: 'profiles',
		label: 'Profiles',
		icon: 'lucide:layers',
		description: 'Reusable tool bundles',
		group: 'artifacts-access'
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
		id: 'chat-apps',
		label: 'Chat Apps',
		icon: 'lucide:send',
		description: 'Control Clopen from Telegram',
		group: 'preferences'
	},
	{
		id: 'access',
		label: 'Sign-in & Devices',
		icon: 'lucide:shield',
		description: 'Login, access token, and signed-in devices',
		group: 'system'
	},
	{
		id: 'files',
		label: 'Files & Folders',
		icon: 'lucide:folder-cog',
		description: 'Project locations and file size limit',
		group: 'system'
	},
	{
		id: 'machine',
		label: 'Machine',
		icon: 'lucide:server',
		description: 'Hardware and status of the machine running Clopen',
		group: 'system'
	},
	{
		id: 'system',
		label: 'Maintenance',
		icon: 'lucide:settings-2',
		description: 'Updates and data',
		group: 'system'
	}
];

// Create the state using Svelte 5 runes
export const settingsModalState = $state<SettingsModalState>({
	isOpen: false,
	activeSection: 'assistant',
	engineFocus: null,
	integrationFocusProvider: null
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

/**
 * Open Integrations with one provider's Connect dialog already up.
 *
 * `providerId` is a hint, not a promise: a provider that is not in the registry
 * (or is already connected) simply lands on the list, which is the same place
 * the user would have arrived at anyway.
 */
export function openIntegrationConnect(providerId: string) {
	settingsModalState.isOpen = true;
	settingsModalState.activeSection = 'integrations';
	settingsModalState.integrationFocusProvider = providerId;
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
