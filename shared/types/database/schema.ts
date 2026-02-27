/**
 * Database-specific types
 *
 * Uses official @anthropic-ai/claude-agent-sdk types for consistency
 */

import type { SDKMessage, EngineSDKMessage } from '../messaging';
import type { EngineType } from '../engine';

// Core database entities moved from core folder
export interface Project {
	id: string;
	name: string;
	path: string;
	created_at: string;
	last_opened_at: string;
}

export interface ChatSession {
	id: string;
	project_id: string;
	title?: string;
	engine?: EngineType; // AI engine used for this session
	model?: string; // Compound model ID (e.g., 'claude-code:haiku', 'opencode:gpt-5.2')
	claude_account_id?: number; // Per-session Claude account override (references claude_accounts.id)
	latest_sdk_session_id?: string; // Latest SDK session_id from responses
	current_head_message_id?: string; // Git-like HEAD pointer to current branch tip
	started_at: string;
	ended_at?: string;
}

export interface Settings {
	key: string;
	value: string;
	updated_at: string;
}


/**
 * Database Message interface
 * Stores official SDKMessage as JSON with additional metadata
 */
export interface DatabaseMessage {
	id: string;
	session_id: string;
	timestamp: string;
	// Store the complete SDKMessage as JSON for full fidelity
	sdk_message: string; // JSON string of SDKMessage
	// User identification for shared chat
	sender_id?: string | null;
	sender_name?: string | null;
	// Git-like commit graph support
	parent_message_id?: string | null; // Parent message (like git parent commit)
	// Soft delete and branch support for undo/redo (deprecated, kept for backward compatibility)
	is_deleted?: number; // 0 = active, 1 = soft deleted
	branch_id?: string | null; // Branch identifier (now used as branch name)
}

/**
 * SDK Message with database timestamp and user info for UI display
 */
export type SDKMessageFormatter = EngineSDKMessage & {
	partialText?: string; // Accumulated partial text for streaming messages (transient, not persisted)
	metadata?: { // System-added info (not part of official SDK response)
		message_id?: string; // Database message ID
		created_at?: string; // Message creation timestamp
		sender_id?: string | null; // User ID who submitted the chat (user messages only)
		sender_name?: string | null; // Display name of who submitted the chat (user messages only)
		parent_message_id?: string | null; // Git-like parent pointer
		engine?: string; // Engine type that produced this message (claude-code, opencode)
		reasoning?: boolean; // Whether this message is a reasoning/thinking message
	};
};

/**
 * Database-specific Setting interface
 * Different from core Settings which might have different structure
 */
export interface Setting {
	key: string;
	value: string;
	updated_at: string;
}

/**
 * Message Snapshot for time travel feature
 * Supports both full snapshots and delta (incremental) snapshots
 */
export interface MessageSnapshot {
	id: string;
	message_id: string;
	session_id: string;
	project_id: string;
	files_snapshot: string; // JSON string of {[filepath]: fileContent} (legacy) or '{}' (blob-store format)
	project_metadata?: string; // JSON string with project metadata
	created_at: string;
	snapshot_type?: 'full' | 'delta'; // Type of snapshot (default: 'full')
	parent_snapshot_id?: string; // Reference to parent snapshot (for delta snapshots)
	delta_changes?: string; // JSON string of delta changes (legacy: full content, blob-store: hash references)
	// File change statistics (git-like)
	files_changed?: number; // Number of files changed
	insertions?: number; // Number of lines inserted
	deletions?: number; // Number of lines deleted
	// Soft delete and branch support for undo/redo
	is_deleted?: number; // 0 = active, 1 = soft deleted
	branch_id?: string | null; // Branch identifier for multi-branch redo
	// Blob store format (new): tree hash for content-addressable storage
	tree_hash?: string | null; // When set, snapshot uses blob store (files in ~/.clopen/snapshots/)
}

/**
 * Delta changes structure for incremental snapshots
 */
export interface DeltaChanges {
	added: { [filepath: string]: string }; // New files
	modified: { [filepath: string]: string }; // Changed files with new content
	deleted: string[]; // Deleted file paths
}

/**
 * Session Relationship for tracking session branching
 */
export interface SessionRelationship {
	id: string;
	parent_session_id: string;
	child_session_id: string;
	branched_from_message_id?: string;
	created_at: string;
}

/**
 * Branch tracking for git-like version control
 * Each branch has a name and points to a HEAD message
 */
export interface Branch {
	id: string;
	session_id: string;
	branch_name: string; // Human-readable branch name (e.g., "version_1", "version_2")
	head_message_id: string; // Points to the tip of this branch
	created_at: string;
}