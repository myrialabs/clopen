import type { EngineType } from '$shared/types/unified';

/**
 * One engine session as it sits on disk.
 *
 * `id` is the id Clopen stores on messages (`UnifiedMessage.sessionId`) and
 * passes back as `resume`, so "is this transcript in use" is a lookup of `id`
 * in the chats' engine references.
 */
export interface TranscriptEntry {
	engine: EngineType;
	id: string;
	/** What removing this entry deletes. */
	paths: string[];
	bytes: number;
	mtimeMs: number;
	/**
	 * The engine's own name for the project directory the transcript belongs to
	 * (Claude/Qwen/Pi/Cursor encode the project path into a folder name). Used to
	 * group entries; null when the store does not partition by project.
	 */
	projectKey: string | null;
	/** The project path when the store records it (Codex, Pi, OpenCode). */
	projectPath: string | null;
	/**
	 * Claude keeps per-session side files (`<id>/tool-results`, `<id>/subagents`)
	 * that LATER forks point at by path. Never removed with the transcript; only
	 * once no transcript left in the folder mentions the id.
	 */
	sidecar?: { path: string; bytes: number } | null;
	/** A Claude side folder whose transcript is already gone. */
	sidecarOnly?: boolean;
	/** OpenCode: the session this one was forked or spawned from. */
	parentId?: string | null;
}

export interface TranscriptRemoval {
	freedBytes: number;
	removed: number;
	errors: string[];
}

export interface TranscriptStore {
	engine: EngineType;
	/** Every transcript on disk. Missing stores list nothing. */
	list(signal?: AbortSignal): Promise<TranscriptEntry[]>;
	/** Whether `id` can still be resumed. */
	exists(id: string, projectPath: string): Promise<boolean>;
	/** Delete entries previously returned by `list()`. */
	remove(entries: TranscriptEntry[]): Promise<TranscriptRemoval>;
	/**
	 * The directory the whole store lives in. Anything under the engine home
	 * outside it is cache, config or logs.
	 */
	roots(): string[];
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
