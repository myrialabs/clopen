/**
 * Library Modal Store — what the owner (and Clopen) builds and reuses:
 * skills, scripts, specialists, rules, toolsets, integrations and secrets.
 *
 * Kept apart from Settings on purpose: Settings is how Clopen behaves; the
 * Library is the know-how it works with. Two places with clear jobs read
 * better than one long list mixing both.
 */

import type { IconName } from '$shared/types/ui/icons';

export type LibrarySection = 'skills' | 'scripts' | 'subagents' | 'rules' | 'toolsets' | 'integrations' | 'secrets';

export interface LibrarySectionMeta {
	id: LibrarySection;
	label: string;
	icon: IconName;
	description: string;
}

export const librarySections: LibrarySectionMeta[] = [
	{ id: 'skills', label: 'Skills', icon: 'lucide:graduation-cap', description: 'Know-how and /commands' },
	{ id: 'scripts', label: 'Scripts', icon: 'lucide:square-terminal', description: 'Steps that run without AI' },
	{ id: 'subagents', label: 'Specialists', icon: 'lucide:bot', description: 'Experts an agent can call' },
	{ id: 'rules', label: 'Rules', icon: 'lucide:scroll-text', description: 'What every agent follows' },
	{ id: 'toolsets', label: 'Toolsets', icon: 'lucide:layers', description: 'Tool bundles per chat' },
	{ id: 'integrations', label: 'Integrations', icon: 'lucide:plug', description: 'Connected apps and tools' },
	{ id: 'secrets', label: 'Secrets', icon: 'lucide:key-round', description: 'Passwords and keys, encrypted' }
];

interface LibraryModalState {
	isOpen: boolean;
	activeSection: LibrarySection;
	/**
	 * Provider whose Connect dialog should open as soon as Integrations is shown.
	 * Set by a CTA that already knows what the user is trying to connect (the
	 * Issues & PRs surface's empty state, for one). IntegrationsSettings
	 * consumes and clears it.
	 */
	integrationFocusProvider: string | null;
}

export const libraryModalState = $state<LibraryModalState>({
	isOpen: false,
	activeSection: 'skills',
	integrationFocusProvider: null
});

export function openLibrary(section: LibrarySection = 'skills') {
	libraryModalState.isOpen = true;
	libraryModalState.activeSection = section;
}

export function closeLibrary() {
	libraryModalState.isOpen = false;
}

export function setLibrarySection(section: LibrarySection) {
	libraryModalState.activeSection = section;
}

/** Open Integrations with one provider's Connect dialog already up. */
export function openIntegrationConnect(providerId: string) {
	libraryModalState.isOpen = true;
	libraryModalState.activeSection = 'integrations';
	libraryModalState.integrationFocusProvider = providerId;
}
