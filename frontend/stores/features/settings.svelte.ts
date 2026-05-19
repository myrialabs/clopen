/**
 * Settings Store with Svelte 5 Runes
 *
 * Centralized store for user settings with server-side persistence.
 * Per-user settings: stored via user:save-state / user:restore-state
 * System settings: stored via settings:get / settings:update-system (admin-only write)
 */

import { DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME, DEFAULT_ENGINE } from '$shared/constants/engines';
import type { AppSettings, SystemSettings } from '$shared/types/stores/settings';
import { builtInPresets } from '$frontend/stores/ui/workspace.svelte';
import ws from '$frontend/utils/ws';

import { debug } from '$shared/utils/logger';

// Create default visibility map (all presets visible by default)
const createDefaultPresetVisibility = (): Record<string, boolean> => {
	const visibility: Record<string, boolean> = {};
	builtInPresets.forEach((preset) => {
		visibility[preset.id] = true;
	});
	return visibility;
};

// Default per-user settings
const defaultSettings: AppSettings = {
	selectedEngine: DEFAULT_ENGINE,
	selectedProvider: 'anthropic',
	selectedModelId: DEFAULT_MODEL_ID,
	selectedModelName: DEFAULT_MODEL_NAME,
	engineModelMemory: { 'claude-code': { provider: 'anthropic', id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME } },
	autoSave: true,
	theme: 'system',
	soundNotifications: true,
	pushNotifications: false,
	layoutPresetVisibility: createDefaultPresetVisibility(),
	fontSize: 13,
	chatAppearance: 'classic',
	gitDiffSideBySide: true,
	commitGenerator: {
		useCustomModel: false,
		engine: 'claude-code',
		provider: 'anthropic',
		modelId: 'haiku',
		modelName: 'Haiku 4.5',
		format: 'single-line'
	}
};

// Default system settings
const defaultSystemSettings: SystemSettings = {
	authMode: 'required',
	onboardingComplete: false,
	allowedBasePaths: [],
	autoUpdate: false,
	sessionLifetimeDays: 30
};

// Create and export reactive settings state directly (starts with defaults)
export const settings = $state<AppSettings>({ ...defaultSettings });

// System-wide settings (admin-configurable, read by all users)
export const systemSettings = $state<SystemSettings>({ ...defaultSystemSettings });

export function applyFontSize(size: number): void {
	if (typeof window !== 'undefined') {
		document.documentElement.style.fontSize = `${size}px`;
	}
}

/**
 * Apply server-provided per-user settings during initialization.
 * Called from WorkspaceLayout with state from user:restore-state.
 */
export function applyServerSettings(serverSettings: Partial<AppSettings> | null): void {
	if (serverSettings && typeof serverSettings === 'object') {
		// Merge with defaults to ensure all properties exist
		const merged = { ...defaultSettings, ...serverSettings };
		// Deep merge nested objects so new default fields are preserved
		if (serverSettings.commitGenerator) {
			merged.commitGenerator = { ...defaultSettings.commitGenerator, ...serverSettings.commitGenerator };
		}
		Object.assign(settings, merged);
		applyFontSize(settings.fontSize);
		debug.log('settings', 'Applied server settings');
	}
}

/**
 * Load system settings from server.
 * Called during initialization after auth is ready.
 */
export async function loadSystemSettings(): Promise<void> {
	try {
		const result = await ws.http('settings:get', { key: 'system:settings' });
		if (result?.value) {
			const parsed = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
			Object.assign(systemSettings, { ...defaultSystemSettings, ...parsed });
			debug.log('settings', 'Loaded system settings');
		}
	} catch {
		// System settings may not exist yet — use defaults
		debug.log('settings', 'No system settings found, using defaults');
	}
}

/**
 * Save system settings (admin only).
 */
export async function updateSystemSettings(newSettings: Partial<SystemSettings>): Promise<void> {
	Object.assign(systemSettings, newSettings);
	try {
		await ws.http('settings:update', {
			key: 'system:settings',
			value: JSON.stringify({ ...systemSettings })
		});
		debug.log('settings', 'System settings saved');
	} catch (err) {
		debug.error('settings', 'Failed to save system settings:', err);
	}
}

// Save per-user settings to server (fire-and-forget)
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
