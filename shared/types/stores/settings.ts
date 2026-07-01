import type { EngineType } from '$shared/types/unified';
import type { CommitMessageFormat } from '$shared/types/git';

export interface CommitMessageConfig {
	style: 'concise' | 'technical' | 'descriptive';
	subjectLength: 50 | 72 | 100;
	allowedTypes: string;
	context: string;
}

export interface BranchNameConfig {
	maxWords: 1 | 2 | 3;
	allowedPrefixes: string;
	context: string;
	branchMessageSeparator?: string;
}

/** AI commit message generator settings */
export interface CommitGeneratorSettings {
	/** When false, uses the chat model (selectedEngine/selectedModel). When true, uses custom engine/model below. */
	useCustomModel: boolean;
	engine: EngineType;
	provider: string;
	modelId: string;
	modelName: string;
	format: CommitMessageFormat;
	/** Separator between prefix and generated description, e.g. '/', '#', '-'. */
	branchSeparator: string;
	ticketLanguage?: 'auto' | 'en';
	ticketSource?: 'none' | 'trello';
	ticketPrefix?: 'short-link' | 'id-short';
	commitConfig: CommitMessageConfig;
	branchConfig: BranchNameConfig;
}

/** Per-user settings (stored per user) */
export interface AppSettings {
	selectedEngine: EngineType;
	selectedProvider: string;
	selectedModelId: string;
	selectedModelName: string;
	/** Remembers the last selected model per engine so switching engines preserves choices */
	engineModelMemory: Record<string, { provider: string; id: string; name: string }>;
	autoSave: boolean;
	theme: 'light' | 'dark' | 'system';
	soundNotifications: boolean;
	/** Sound id — preset id (e.g. 'default', 'chime') or 'custom' for the user-uploaded file. */
	notificationSound: string;
	/** Playback volume, 0..1. Default: 1. */
	notificationVolume: number;
	pushNotifications: boolean;
	layoutPresetVisibility: Record<string, boolean>;
	/** Base font size in pixels (10–20). Default: 13. */
	fontSize: number;
	/** Chat message appearance variant. Default: 'classic'. */
	chatAppearance: 'classic' | 'compact';
	/** Git diff viewer layout — true = side-by-side (2 columns), false = inline (1 column). Default: true. */
	gitDiffSideBySide: boolean;
	/** AI commit message generator configuration */
	commitGenerator: CommitGeneratorSettings;
	/** Pinned model IDs — shown at top of provider group in model picker */
	pinnedModels: string[];
}

/** Authentication mode */
export type AuthMode = 'none' | 'required';

/** System-wide settings (admin-only, shared across all users) */
export interface SystemSettings {
	/** Authentication mode: 'none' = single user no login, 'required' = multi-user with login. Default: 'required'. */
	authMode: AuthMode;
	/** Whether the initial setup wizard has been completed. Default: false. */
	onboardingComplete: boolean;
	/** Restrict folder browser to only these base paths. Empty = no restriction. */
	allowedBasePaths: string[];
	/** Automatically update to the latest version when available. Default: false. */
	autoUpdate: boolean;
	/** Session lifetime in days. Default: 30. */
	sessionLifetimeDays: number;
	/** Maximum file size (megabytes) for write, upload, zip, and extract operations. Default: 500. */
	maxFileSizeMB: number;
}
