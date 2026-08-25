/**
 * Settings Store with Svelte 5 Runes
 *
 * Centralized store for user settings with server-side persistence.
 * Per-user settings: stored via user:save-state / user:restore-state
 * System settings: stored via settings:get / settings:update-system (admin-only write)
 */

import { DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME, DEFAULT_ENGINE } from '$shared/constants/engines';
import { DEFAULT_BRANCH_SEPARATOR } from '$shared/constants/git';
import type { AppSettings, SystemSettings } from '$shared/types/stores/settings';
import { builtInPresets } from '$frontend/stores/ui/workspace.svelte';
import { loadUserState, resetUserState } from '$frontend/stores/core/user-state.svelte';
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
	selectedProvider: '',
	selectedModelId: DEFAULT_MODEL_ID,
	selectedModelName: DEFAULT_MODEL_NAME,
	engineModelMemory: { 'claude-code': { provider: 'anthropic', id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME } },
	autoSave: true,
	theme: 'system',
	soundNotifications: true,
	notificationSound: 'message',
	notificationVolume: 1,
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
		format: 'single-line',
		branchSeparator: DEFAULT_BRANCH_SEPARATOR,
		commitConfig: { style: 'technical', subjectLength: 72, allowedTypes: '', context: '' },
		branchConfig: { maxWords: 3, allowedPrefixes: '', context: '' }
	},
	pinnedModels: [],
	reasoningDefaults: {}
};

// Default system settings
const defaultSystemSettings: SystemSettings = {
	authMode: 'required',
	onboardingComplete: false,
	allowedBasePaths: [],
	autoUpdate: false,
	sessionLifetimeDays: 30,
	maxFileSizeMB: 500,
	publicBaseUrl: '',
	lastSeenReleaseNotesVersion: ''
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
 * Whether `settings` reflects the server's copy of this user's settings.
 *
 * Until this is true the store holds nothing but defaults, and saving it would
 * replace the user's real settings with those defaults — every save writes the
 * whole object. So saving is blocked until hydration happens. This is what used
 * to wipe engine/model memory, font size, chat appearance and the commit
 * generator config whenever the app rendered without a successful restore
 * (most visibly during the setup wizard, which mounts outside the workspace).
 */
let hydrated = false;

/**
 * Apply server-provided per-user settings during initialization.
 *
 * Call with `null` when the server has no saved settings for this user: that is
 * still a successful hydration (a brand-new user legitimately starts on
 * defaults) and unblocks saving. Only call this after `user:restore-state`
 * actually succeeded.
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
	hydrated = true;
}

/**
 * Load this user's settings from the server and apply them.
 * Safe to call from several entry points — the underlying request is shared.
 * Returns false when the state could not be loaded, in which case the store
 * stays un-hydrated and refuses to persist anything.
 */
export async function hydrateSettings(): Promise<boolean> {
	const state = await loadUserState();
	if (!state) return false;
	applyServerSettings((state.settings as Partial<AppSettings> | null) ?? null);
	return true;
}

/**
 * Forget the hydrated state on sign-out, so the next user's session cannot be
 * saved over with the previous user's settings.
 */
export function resetSettingsHydration(): void {
	hydrated = false;
	Object.assign(settings, defaultSettings);
	resetUserState();
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
 * Returns whether the change was persisted; on failure the local copy is rolled
 * back so the UI never shows a setting the server did not accept.
 */
export async function updateSystemSettings(newSettings: Partial<SystemSettings>): Promise<boolean> {
	const previous = Object.fromEntries(
		Object.keys(newSettings).map((key) => [key, systemSettings[key as keyof SystemSettings]])
	) as Partial<SystemSettings>;

	// Optimistically update the local reactive copy.
	Object.assign(systemSettings, newSettings);
	try {
		// Send ONLY the changed keys — the backend merges them into the stored
		// blob, so a partial write never clobbers sibling fields even if our
		// in-memory copy was stale.
		await ws.http('settings:update-system', { patch: { ...newSettings } });
		debug.log('settings', 'System settings saved');
		return true;
	} catch (err) {
		Object.assign(systemSettings, previous);
		debug.error('settings', 'Failed to save system settings:', err);
		return false;
	}
}

// Save per-user settings to server (fire-and-forget).
// Blocked until hydration: saving a store that still holds defaults would
// replace the user's real settings with them, because every save sends the
// whole object.
function saveSettings(): void {
	if (!hydrated) {
		debug.warn('settings', 'Not saving settings — server copy not loaded yet (would overwrite it with defaults)');
		return;
	}
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

export function togglePinnedModel(modelId: string) {
	const pinned = settings.pinnedModels;
	const idx = pinned.indexOf(modelId);
	if (idx === -1) {
		updateSettings({ pinnedModels: [...pinned, modelId] });
	} else {
		updateSettings({ pinnedModels: pinned.filter(id => id !== modelId) });
	}
}

/**
 * Persist the per-model reasoning/thinking default (Settings → Models + the
 * chat picker share this map). Passing `null` clears the model's entry so it
 * falls back to the engine/model default.
 */
export function setReasoningDefault(modelId: string, level: string | null): void {
	if (!modelId) return;
	const next = { ...settings.reasoningDefaults };
	if (level === null) {
		delete next[modelId];
	} else {
		next[modelId] = level;
	}
	updateSettings({ reasoningDefaults: next });
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
