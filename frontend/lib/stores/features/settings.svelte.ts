/**
 * Settings Store with Svelte 5 Runes
 *
 * Centralized store for user settings with server-side persistence
 * Settings are stored on the server via user:save-state / user:restore-state
 * No localStorage usage - server is single source of truth
 */

import { DEFAULT_MODEL, DEFAULT_ENGINE } from '$shared/constants/engines';
import type { AppSettings } from '$shared/types/stores/settings';
import { builtInPresets } from '$frontend/lib/stores/ui/workspace.svelte';
import ws from '$frontend/lib/utils/ws';

import { debug } from '$shared/utils/logger';

// Create default visibility map (all presets visible by default)
const createDefaultPresetVisibility = (): Record<string, boolean> => {
	const visibility: Record<string, boolean> = {};
	builtInPresets.forEach((preset) => {
		visibility[preset.id] = true;
	});
	return visibility;
};

// Default settings
const defaultSettings: AppSettings = {
	selectedEngine: DEFAULT_ENGINE,
	selectedModel: DEFAULT_MODEL,
	engineModelMemory: { 'claude-code': DEFAULT_MODEL },
	autoSave: true,
	theme: 'system',
	soundNotifications: true,
	pushNotifications: false,
	layoutPresetVisibility: createDefaultPresetVisibility(),
	allowedBasePaths: []
};

// Create and export reactive settings state directly (starts with defaults)
export const settings = $state<AppSettings>({ ...defaultSettings });

/**
 * Apply server-provided settings during initialization.
 * Called from WorkspaceLayout with state from user:restore-state.
 */
export function applyServerSettings(serverSettings: Partial<AppSettings> | null): void {
	if (serverSettings && typeof serverSettings === 'object') {
		// Merge with defaults to ensure all properties exist
		Object.assign(settings, { ...defaultSettings, ...serverSettings });
		debug.log('settings', 'Applied server settings');
	}
}

// Save settings to server (fire-and-forget)
function saveSettings(): void {
	ws.http('user:save-state', { key: 'settings', value: { ...settings } }).catch(err => {
		debug.error('settings', 'Failed to save settings to server:', err);
	});
}

// Export functions directly
export function updateSettings(newSettings: Partial<AppSettings>) {
	Object.assign(settings, newSettings);
	saveSettings();
}

export function resetToDefaults() {
	Object.assign(settings, defaultSettings);
	saveSettings();
}

export function exportSettings(): string {
	return JSON.stringify(settings, null, 2);
}

export function importSettings(settingsJson: string): boolean {
	try {
		const imported = JSON.parse(settingsJson);
		// Validate basic structure
		if (typeof imported === 'object' && imported !== null) {
			updateSettings(imported);
			return true;
		}
	} catch (error) {
		debug.error('settings', 'Failed to import settings:', error);
	}
	return false;
}
