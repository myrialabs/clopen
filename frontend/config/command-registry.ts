/**
 * Command Palette action registry — SSOT for the palette's "Actions" category.
 * Add a new command here and it automatically shows up in the Command Palette.
 */

import type { IconName } from '$shared/types/ui/icons';
import { authStore } from '$frontend/stores/features/auth.svelte';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { createNewChatSession, setCurrentSession } from '$frontend/stores/core/sessions.svelte';
import { toggleNavigator, resetToDefault } from '$frontend/stores/ui/workspace.svelte';
import { toggleDarkMode } from '$frontend/stores/ui/theme.svelte';
import { settings, updateSettings, applyFontSize } from '$frontend/stores/features/settings.svelte';
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

// Font size bounds mirror the Appearance settings slider so the palette and the
// slider can't drift out of sync. Default matches AppSettings.fontSize.
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 24;
const FONT_SIZE_DEFAULT = 13;

/** Set the base font size (clamped) and persist it — mirrors AppearanceSettings. */
function setFontSize(size: number): void {
	const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
	applyFontSize(clamped);
	updateSettings({ fontSize: clamped });
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
		id: 'toggle-dark-mode',
		label: 'Toggle Dark Mode',
		description: 'Switch between light and dark themes',
		icon: 'lucide:moon',
		keywords: ['theme', 'dark', 'light', 'appearance', 'color'],
		run: toggleDarkMode
	});

	// ── Preference toggles ──────────────────────────────────────────────────
	// Each flips one AppSettings field via updateSettings (instant + persisted
	// per-user, no engine). Labels are action-oriented (they name the target
	// state) and keywords cover BOTH sides so either term finds the one command.

	actions.push({
		id: 'toggle-message-layout',
		label: settings.chatAppearance === 'compact' ? 'Use Classic Message Layout' : 'Use Compact Message Layout',
		description: 'Switch how AI chat messages are displayed',
		icon: 'lucide:layout-list',
		keywords: ['message', 'layout', 'chat', 'classic', 'compact', 'density', 'appearance'],
		run: () =>
			updateSettings({ chatAppearance: settings.chatAppearance === 'compact' ? 'classic' : 'compact' })
	});

	// ── Font size ───────────────────────────────────────────────────────────
	actions.push({
		id: 'increase-font-size',
		label: 'Increase Font Size',
		description: 'Make the interface text larger',
		icon: 'lucide:zoom-in',
		keywords: ['font', 'text', 'size', 'bigger', 'larger', 'zoom', 'increase'],
		run: () => setFontSize(settings.fontSize + 1)
	});

	actions.push({
		id: 'decrease-font-size',
		label: 'Decrease Font Size',
		description: 'Make the interface text smaller',
		icon: 'lucide:zoom-out',
		keywords: ['font', 'text', 'size', 'smaller', 'zoom', 'decrease'],
		run: () => setFontSize(settings.fontSize - 1)
	});

	actions.push({
		id: 'reset-font-size',
		label: 'Reset Font Size',
		description: `Restore the default text size (${FONT_SIZE_DEFAULT}px)`,
		icon: 'lucide:type',
		keywords: ['font', 'text', 'size', 'default', 'reset'],
		run: () => setFontSize(FONT_SIZE_DEFAULT)
	});

	// Layout presets are intentionally NOT exposed as palette commands — they live
	// in the dedicated Layout Presets menu, and listing all of them here just
	// clutters search. Only "Reset Layout" stays as a quick utility.
	actions.push({
		id: 'reset-layout',
		label: 'Reset Layout',
		description: 'Restore the default panel arrangement',
		icon: 'lucide:rotate-ccw',
		keywords: ['layout', 'default', 'reset', 'panel'],
		run: resetToDefault
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
