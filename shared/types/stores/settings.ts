import type { EngineType } from '$shared/types/engine';

export interface AppSettings {
	selectedEngine: EngineType;
	selectedModel: string;
	/** Remembers the last selected model per engine so switching engines preserves choices */
	engineModelMemory: Record<string, string>;
	autoSave: boolean;
	theme: 'light' | 'dark' | 'system';
	soundNotifications: boolean;
	pushNotifications: boolean;
	layoutPresetVisibility: Record<string, boolean>;
	/** Restrict folder browser to only these base paths. Empty = no restriction. */
	allowedBasePaths: string[];
}
