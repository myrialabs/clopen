/**
 * Engine Types (Backend)
 *
 * Defines the AIEngine interface that all engine adapters must implement.
 * Every adapter normalizes its output to Claude SDK format (SDKMessage)
 * so stream-manager and frontend remain engine-agnostic.
 */

import type { SDKMessage, SDKUserMessage, EngineSDKMessage } from '$shared/types/messaging';
import type { EngineType, EngineModel } from '$shared/types/engine';

export type { EngineType, EngineModel };

/** Options passed to engine.streamQuery() */
export interface EngineQueryOptions {
	projectPath: string;
	prompt: SDKUserMessage;
	resume?: string;
	forkSession?: boolean;
	maxTurns?: number;
	model?: string;
	includePartialMessages?: boolean;
	abortController?: AbortController;
	claudeAccountId?: number;
}

/** The contract every engine adapter must fulfil */
export interface AIEngine {
	/** Engine identifier */
	readonly name: EngineType;

	/** Whether the engine has been initialized */
	readonly isInitialized: boolean;

	/** Lazy initialization (start server, load config, etc.) */
	initialize(): Promise<void>;

	/** Cleanup resources */
	dispose(): Promise<void>;

	/**
	 * Stream a query.
	 * MUST yield messages in Claude SDK format (SDKMessage).
	 */
	streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineSDKMessage, void, unknown>;

	/** Cancel the active query */
	cancel(): Promise<void>;

	/** Interrupt the active query (soft stop) */
	interrupt(): Promise<void>;

	/** Check if a query is currently active */
	readonly isActive: boolean;

	/** Return the list of models this engine supports */
	getAvailableModels(): Promise<EngineModel[]>;
}
