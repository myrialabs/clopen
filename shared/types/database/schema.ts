/**
 * Database-specific types
 */

import type { EngineType } from '../unified';

// Core database entities moved from core folder
export interface Project {
	id: string;
	name: string;
	path: string;
	created_at: string;
	last_opened_at: string;
}

export interface ChatSession {
	// ── Identity ──
	id: string;
	project_id: string;
	started_at: string;
	ended_at?: string;

	// ── Session preferences (user-selected, persist across HEAD changes) ──
	title?: string; // Conversation title — auto-set from first user message, editable
	engine?: EngineType; // AI engine used for this session
	provider?: string; // Provider slug (e.g., 'anthropic', 'openai', 'opencode')
	model_id?: string; // Model identifier (e.g., 'sonnet', 'gpt-5.2')
	model_name?: string; // Display name (e.g., 'Sonnet 4.6', 'GPT-5.2')
	account_id?: number; // Engine account used for this session
	account_name?: string; // Display name of the selected account

	// ── HEAD state (re-derived when HEAD changes: undo/redo/restore/branch) ──
	head_message_id?: string; // Git-like HEAD pointer to current branch tip
	head_session_id?: string; // Engine-issued session ID for resume (aligns with MessageBase.sessionId)
	head_title?: string; // Last user message text at HEAD (truncated)
	head_summary?: string; // Last assistant response text at HEAD (truncated)

	// ── Activity tracking (updated on each message) ──
	sender_id?: string; // Last active user
	sender_name?: string;
	message_count?: number; // Total messages (all types)
	user_count?: number; // User messages only
	last_message_at?: string; // Timestamp of the latest message
}

export interface Settings {
	key: string;
	value: string;
	updated_at: string;
}


/**
 * Database Message interface.
 *
 * `data` (JSON blob of UnifiedMessage) is the **single source of truth**.
 * The other columns are **indexed projections** of fields inside the JSON,
 * kept in sync at write-time for SQL performance (WHERE, ORDER BY, graph traversal).
 */
export interface DatabaseMessage {
	/** Primary key — projection of data.messageId */
	id: string;
	/** Projection of data.sessionId — used in WHERE filters */
	session_id: string;
	/** Projection of data.createdAt — used in ORDER BY and range queries */
	created_at: string;
	/** Serialized UnifiedMessage JSON — the canonical source of truth */
	data: string;
	/** Projection of data.parent.messageId — used in graph traversal (getPathToRoot, getChildren) */
	parent_message_id?: string | null;
	is_deleted?: number;
	branch_id?: string | null;
}

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
	// Session-scoped changes: { filepath: { oldHash, newHash } }
	session_changes?: string | null; // JSON string of SessionScopedChanges
}

/**
 * Session-scoped file change entry for a single file
 */
export interface SessionFileChange {
	oldHash: string; // Hash of file content before change
	newHash: string; // Hash of file content after change
}

/**
 * Session-scoped changes map: filepath → { oldHash, newHash }
 * Used for session-scoped restore and conflict detection
 */
export interface SessionScopedChanges {
	[filepath: string]: SessionFileChange;
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

/**
 * db-client query history row (raw SQLite shape).
 * Mirrors columns in `db_client_query_history` (migration 031).
 */
export interface DBDbClientQueryHistoryRow {
	id: string;
	connection_id: string;
	user_id: string | null;
	query: string;
	duration_ms: number | null;
	row_count: number | null;
	status: 'success' | 'error';
	error: string | null;
	executed_at: string;
}

/**
 * db-client connection row (raw SQLite shape).
 * Mirrors columns in `db_client_connections` (migration 031).
 */
export interface DBDbClientConnectionRow {
	id: string;
	name: string;
	driver: 'mysql' | 'postgres' | 'sqlite' | 'mongodb' | 'redis';
	host: string | null;
	port: number | null;
	username: string | null;
	password: string | null;
	database: string | null;
	ssl_mode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
	ssl_ca: string | null;
	ssh_enabled: number;
	ssh_host: string | null;
	ssh_port: number | null;
	ssh_username: string | null;
	ssh_auth_method: 'password' | 'key';
	ssh_password: string | null;
	ssh_private_key: string | null;
	ssh_passphrase: string | null;
	options_json: string | null;
	color: string | null;
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
}

