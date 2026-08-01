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
}

/** AI commit message generator settings */
export interface CommitGeneratorSettings {
	/** When false, uses the chat model (selectedEngine/selectedModel). When true, uses custom engine/model below. */
	useCustomModel: boolean;
	engine: EngineType;
	/**
	 * Provider of `modelId`. Write it with `modelFieldsOf()` so it can never lag
	 * behind a model change — the backend re-derives it anyway
	 * (`backend/engine/resolve-model.ts`), but a stale value here is misleading.
	 */
	provider: string;
	modelId: string;
	modelName: string;
	format: CommitMessageFormat;
	/** Separator between prefix and generated description, e.g. '/', '#', '-'. */
	branchSeparator: string;
	commitConfig: CommitMessageConfig;
	branchConfig: BranchNameConfig;
}

/**
 * AI authoring model for generating Skills/Commands/Subagents/Instructions from a
 * purpose sentence. Optional — when absent (or `useCustomModel` false), the
 * assistant model (selectedEngine/selectedModel) is used.
 */
export interface ArtifactGeneratorSettings {
	useCustomModel: boolean;
	engine: EngineType;
	/** See `CommitGeneratorSettings.provider` — write via `modelFieldsOf()`. */
	provider: string;
	modelId: string;
	modelName: string;
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
	/** AI authoring model for artifact generation (optional; falls back to assistant model) */
	artifactGenerator?: ArtifactGeneratorSettings;
	/** Pinned model IDs — shown at top of provider group in model picker */
	pinnedModels: string[];
	/**
	 * Per-model reasoning/thinking level defaults, keyed by model id. Stores the
	 * native level token (e.g. 'high'). Seeds new sessions and remembers the last
	 * level chosen per model. Absent key → use the engine/model default.
	 */
	reasoningDefaults: Record<string, string>;
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
	/**
	 * Public base URL Remote Access share links are built against (e.g.
	 * https://clopen.example.com). Set for VPS/reverse-proxy deployments where the
	 * app is already reachable on a domain; when empty, Remote Access falls back to
	 * the current origin or a Cloudflare quick tunnel. Default: '' (unset).
	 */
	publicBaseUrl?: string;
	/** Latest version the "What's New" preview dialog has been dismissed for. Default: '' (never dismissed). */
	lastSeenReleaseNotesVersion?: string;
}
