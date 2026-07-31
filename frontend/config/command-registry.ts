/**
 * Command Palette action registry — SSOT for the palette's "Actions" category.
 * Add a new command here and it automatically shows up in the Command Palette.
 */

import type { IconName } from '$shared/types/ui/icons';
import { authStore } from '$frontend/stores/features/auth.svelte';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { createNewChatSession, setCurrentSession } from '$frontend/stores/core/sessions.svelte';
import { toggleNavigator } from '$frontend/stores/ui/workspace.svelte';
import { openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
import {
	openNewProjectDialog,
	openRemoteAccessDialog,
	openTunnelDialog,
	openDbClientDialog
} from '$frontend/stores/ui/quick-panels.svelte';
import { addNotification } from '$frontend/stores/ui/notification.svelte';

export interface CommandAction {
	id: string;
	label: string;
	description: string;
	icon: IconName;
	keywords?: string[];
	run: () => void | Promise<void>;
}

async function runNewChatSession() {
	const project = projectState.currentProject;
	if (!project) return;

	const session = await createNewChatSession(project.id);
	if (session) {
		await setCurrentSession(session);
	} else {
		addNotification({
			type: 'error',
			title: 'Failed to Create Session',
			message: 'Could not create a new chat session',
			duration: 5000
		});
	}
}

/** Actions visible right now — gated by admin role and current project context. */
export function getCommandActions(): CommandAction[] {
	const actions: CommandAction[] = [];

	if (authStore.isAdmin) {
		actions.push({
			id: 'new-project',
			label: 'New Project',
			description: 'Add a project from a folder on disk',
			icon: 'lucide:folder-plus',
			keywords: ['add', 'create', 'open', 'folder'],
			run: openNewProjectDialog
		});
	}

	if (projectState.currentProject) {
		actions.push({
			id: 'new-chat-session',
			label: 'New Chat Session',
			description: `Start a fresh session in ${projectState.currentProject.name}`,
			icon: 'lucide:message-square-plus',
			keywords: ['chat', 'session', 'new'],
			run: runNewChatSession
		});
	}

	actions.push({
		id: 'toggle-sidebar',
		label: 'Toggle Sidebar',
		description: 'Collapse or expand the project navigator',
		icon: 'lucide:panel-left-close',
		keywords: ['navigator', 'collapse', 'expand', 'sidebar'],
		run: toggleNavigator
	});

	actions.push({
		id: 'remote-access',
		label: 'Remote Access',
		description: 'Share a link to reach this Clopen',
		icon: 'lucide:radio',
		keywords: ['share', 'device', 'invite', 'link'],
		run: openRemoteAccessDialog
	});

	actions.push({
		id: 'public-tunnel',
		label: 'Public Tunnel',
		description: 'Expose a local port via Cloudflare',
		icon: 'lucide:cloud-upload',
		keywords: ['cloudflare', 'expose', 'port'],
		run: openTunnelDialog
	});

	actions.push({
		id: 'db-client',
		label: 'DB Client',
		description: 'Connect to a database',
		icon: 'lucide:database',
		keywords: ['sql', 'database', 'query'],
		run: openDbClientDialog
	});

	actions.push({
		id: 'open-settings',
		label: 'Open Settings',
		description: 'Assistant, engines, appearance, and more',
		icon: 'lucide:settings',
		keywords: ['preferences', 'config'],
		run: () => openSettingsModal()
	});

	return actions;
}
