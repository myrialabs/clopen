import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Deep-convert messages to unified format, enrich both engines, rename columns, drop sender columns';

// ============================================================
// Row Types (before and after column rename)
// ============================================================

interface OldRow {
	id: string;
	session_id: string;
	timestamp: string;
	sdk_message: string;
	sender_id: string | null;
	sender_name: string | null;
	parent_message_id: string | null;
}

interface NewRow {
	id: string;
	session_id: string;
	data: string;
	parent_message_id: string | null;
}

// ============================================================
// Shared Helpers
// ============================================================

function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ============================================================
// Claude Code Helpers
// ============================================================

/** Map Claude SDK stop_reason → unified StopReason */
function mapClaudeStopReason(sdkStop: string | null | undefined): string | null {
	switch (sdkStop) {
		case 'end_turn': return 'end_turn';
		case 'tool_use': return 'tool_use';
		case 'max_tokens': return 'max_tokens';
		case 'interrupted': return 'interrupted';
		default: return sdkStop ? 'end_turn' : null;
	}
}

const GREP_OPTION_MAP: Record<string, string> = {
	'-i': 'caseInsensitive',
	'-n': 'lineNumbers',
	'-A': 'afterContext',
	'-B': 'beforeContext',
	'-C': 'context',
};

/** Normalize Claude SDK tool input: snake_case → camelCase, Grep dash options */
function convertClaudeToolInput(toolName: string, raw: Record<string, unknown>): Record<string, unknown> {
	const converted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (toolName === 'Grep' && key in GREP_OPTION_MAP) {
			converted[GREP_OPTION_MAP[key]] = value;
		} else {
			converted[snakeToCamel(key)] = value;
		}
	}
	return converted;
}

/** Normalize Claude tool name: Task → Agent */
function normalizeClaudeToolName(name: string): string {
	if (name === 'Task') return 'Agent';
	return name;
}

// ============================================================
// OpenCode Helpers
// ============================================================

/** Map OpenCode finish reason → unified StopReason */
function mapOpenCodeStopReason(finish: string | null | undefined): string | null {
	switch (finish) {
		case 'tool-calls': return 'tool_use';
		case 'stop': return 'end_turn';
		case 'length': return 'max_tokens';
		default: return finish ? 'end_turn' : null;
	}
}

/** OpenCode tool name → unified tool name */
const OC_TOOL_NAME_MAP: Record<string, string> = {
	'bash': 'Bash',
	'view': 'Read',
	'read': 'Read',
	'write': 'Write',
	'edit': 'Edit',
	'patch': 'Patch',
	'glob': 'Glob',
	'grep': 'Grep',
	'list': 'List',
	'fetch': 'WebFetch',
	'web_fetch': 'WebFetch',
	'webfetch': 'WebFetch',
	'web_search': 'WebSearch',
	'websearch': 'WebSearch',
	'todo_write': 'TodoWrite',
	'todowrite': 'TodoWrite',
	'todoread': 'TodoWrite',
	'task': 'Agent',
	'question': 'AskUserQuestion',
	'skill': 'Skill',
	'lsp': 'Lsp',
	'list_mcp_resources': 'ListMcpResources',
	'read_mcp_resource': 'ReadMcpResource',
};

/** Normalize OpenCode tool name → unified PascalCase */
function normalizeOpenCodeToolName(name: string): string {
	const lower = name.toLowerCase();
	return OC_TOOL_NAME_MAP[lower] || OC_TOOL_NAME_MAP[name] || name;
}

/** Normalize OpenCode tool input: snake_case → camelCase, Grep dash options */
function convertOpenCodeToolInput(toolName: string, raw: Record<string, unknown>): Record<string, unknown> {
	// MCP tools pass through as-is
	if (toolName.startsWith('mcp__')) return raw;
	const converted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (toolName === 'Grep' && key in GREP_OPTION_MAP) {
			converted[GREP_OPTION_MAP[key]] = value;
		} else {
			converted[snakeToCamel(key)] = value;
		}
	}
	return converted;
}

// ============================================================
// Format Detection
// ============================================================

/** Old SDK format lacks `parent` object at root; unified always has it */
function isOldSdkFormat(raw: Record<string, unknown>): boolean {
	return !('parent' in raw);
}

// ============================================================
// Phase 1: Convert Old ClaudeCode SDK Format → Unified
// ============================================================

function convertClaudeAssistantContent(message: Record<string, unknown> | undefined): unknown[] {
	if (!message) return [{ type: 'text', text: '' }];
	const rawContent = message.content;
	if (typeof rawContent === 'string') return [{ type: 'text', text: rawContent }];
	if (!Array.isArray(rawContent)) return [{ type: 'text', text: '' }];

	const blocks: unknown[] = [];
	for (const block of rawContent as Record<string, unknown>[]) {
		switch (block.type) {
			case 'text':
				blocks.push({ type: 'text', text: (block.text as string) || '' });
				break;
			case 'tool_use': {
				const rawName = (block.name as string) || '';
				const name = normalizeClaudeToolName(rawName);
				const rawInput = (block.input as Record<string, unknown>) || {};
				blocks.push({
					type: 'tool_use',
					id: (block.id as string) || '',
					name,
					input: convertClaudeToolInput(rawName, rawInput),
					result: null,
					subActivities: [],
					skillPrompt: null,
					interrupted: false,
				});
				break;
			}
			// Skip thinking/redacted_thinking — extracted separately
		}
	}
	if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
	return blocks;
}

function convertClaudeUserContent(message: Record<string, unknown> | undefined): unknown[] {
	if (!message) return [{ type: 'text', text: '' }];
	const rawContent = message.content;
	if (typeof rawContent === 'string') return [{ type: 'text', text: rawContent }];
	if (!Array.isArray(rawContent)) return [{ type: 'text', text: '' }];

	const blocks: unknown[] = [];
	for (const block of rawContent as Record<string, unknown>[]) {
		switch (block.type) {
			case 'text':
				blocks.push({ type: 'text', text: (block.text as string) || '' });
				break;
			case 'tool_result':
				blocks.push({
					type: 'tool_result',
					toolUseId: (block.tool_use_id as string) || '',
					content: typeof block.content === 'string'
						? block.content
						: JSON.stringify(block.content ?? ''),
					isError: !!(block.is_error),
				});
				break;
			case 'image': {
				const source = block.source as Record<string, unknown> | undefined;
				blocks.push({
					type: 'image',
					mediaType: (source?.media_type as string) || 'image/png',
					data: (source?.data as string) || '',
				});
				break;
			}
			case 'document': {
				const source = block.source as Record<string, unknown> | undefined;
				blocks.push({
					type: 'document',
					mediaType: (source?.media_type as string) || '',
					data: (source?.data as string) || '',
					title: (block.title as string) || null,
				});
				break;
			}
		}
	}
	if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
	return blocks;
}

function convertClaudeUsage(raw: Record<string, unknown>): Record<string, number> | null {
	const usage = (raw.message as Record<string, unknown>)?.usage as Record<string, unknown> | undefined;
	if (!usage) return null;
	return {
		inputTokens: (usage.input_tokens as number) || 0,
		outputTokens: (usage.output_tokens as number) || 0,
		cacheCreationInputTokens: (usage.cache_creation_input_tokens as number) || 0,
		cacheReadInputTokens: (usage.cache_read_input_tokens as number) || 0,
	};
}

function extractThinkingText(message: Record<string, unknown> | undefined): string {
	if (!message) return '';
	const content = message.content;
	if (!Array.isArray(content)) return '';
	return (content as Record<string, unknown>[])
		.filter(b => b.type === 'thinking')
		.map(b => (b.thinking as string) || '')
		.join('\n');
}

function hasThinkingBlocks(message: Record<string, unknown> | undefined): boolean {
	if (!message) return false;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	return (content as Record<string, unknown>[]).some(b => b.type === 'thinking');
}

function extractText(message: Record<string, unknown> | undefined): string {
	if (!message) return '';
	const content = message.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return (content as Record<string, unknown>[])
			.filter(b => b.type === 'text')
			.map(b => (b.text as string) || '')
			.join('\n');
	}
	return '';
}

/** Convert old SDK format → unified messages (may produce multiple) */
function convertOldFormat(raw: Record<string, unknown>, row: OldRow, sessionEngine: string): Record<string, unknown>[] {
	const metadata = raw.metadata as Record<string, unknown> | undefined;
	const engine = (metadata?.engine as string) || sessionEngine;
	const model = ((raw.message as Record<string, unknown>)?.model as string) || null;

	const base = {
		createdAt: row.timestamp,
		messageId: row.id,
		sessionId: (raw.session_id as string) || null,
		parent: {
			messageId: row.parent_message_id || null,
			sessionId: null,
			toolUseId: null,
		},
		engine,
		model,
		sender: {
			id: row.sender_id || null,
			name: row.sender_name || null,
		},
	};

	const sdkType = raw.type as string;
	const message = raw.message as Record<string, unknown> | undefined;

	// Reasoning (explicit metadata flag)
	if (metadata?.reasoning === true && sdkType === 'assistant') {
		return [{ ...base, type: 'reasoning', text: extractText(message) }];
	}

	// Compact boundary
	if (sdkType === 'system') {
		const cb = raw.compactBoundary as Record<string, unknown> | undefined;
		return [{
			...base,
			type: 'compact_boundary',
			trigger: (cb?.trigger as string) || 'auto',
			preTokens: (cb?.preTokens as number) || 0,
		}];
	}

	// User message
	if (sdkType === 'user') {
		return [{
			...base,
			parent: {
				messageId: row.parent_message_id || null,
				sessionId: null,
				toolUseId: (raw.parent_tool_use_id as string) || null,
			},
			type: 'user',
			content: convertClaudeUserContent(message),
			synthetic: (raw.isSynthetic as boolean) || false,
		}];
	}

	// Assistant message — extract thinking blocks if present
	if (sdkType === 'assistant') {
		const results: Record<string, unknown>[] = [];

		if (hasThinkingBlocks(message)) {
			const thinkingText = extractThinkingText(message);
			if (thinkingText) {
				results.push({
					...base,
					messageId: crypto.randomUUID(),
					type: 'reasoning',
					text: thinkingText,
				});
			}
		}

		results.push({
			...base,
			parent: {
				messageId: row.parent_message_id || null,
				sessionId: null,
				toolUseId: (raw.parent_tool_use_id as string) || null,
			},
			type: 'assistant',
			content: convertClaudeAssistantContent(message),
			stopReason: mapClaudeStopReason(message?.stop_reason as string | undefined),
			usage: convertClaudeUsage(raw),
		});

		return results;
	}

	// Fallback
	return [{
		...base,
		type: 'assistant',
		content: [{ type: 'text', text: '' }],
		stopReason: null,
		usage: null,
	}];
}

/** Sync unified format metadata with DB columns (for already-unified rows) */
function syncMetadata(raw: Record<string, unknown>, row: OldRow, sessionEngine: string): Record<string, unknown> {
	raw.messageId = row.id;
	raw.createdAt = row.timestamp;
	// sessionId is the SDK session ID — do NOT overwrite with chat session_id

	const parent = raw.parent as Record<string, unknown>;
	parent.messageId = row.parent_message_id || null;

	raw.sender = {
		id: row.sender_id || (raw.sender as Record<string, unknown>)?.id || null,
		name: row.sender_name || (raw.sender as Record<string, unknown>)?.name || null,
	};

	if (!raw.engine) raw.engine = sessionEngine;

	return raw;
}

// ============================================================
// Phase 2: Deep-Enrich Already-Unified Messages (Both Engines)
// ============================================================

function hasSnakeCaseKeys(input: Record<string, unknown>): boolean {
	return Object.keys(input).some(k => k.includes('_') || k.startsWith('-'));
}

/** Check if a tool name is in lowercase OpenCode format */
function isOpenCodeToolName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower in OC_TOOL_NAME_MAP;
}

/** Enrich assistant content — engine-aware tool name/input normalization */
function enrichAssistantContent(content: unknown[], engine: string): { changed: boolean; content: unknown[] } {
	let changed = false;
	const isOpenCode = engine === 'opencode';

	const enriched = content.map((block: unknown) => {
		const b = block as Record<string, unknown>;
		if (b.type !== 'tool_use') return b;

		const updates: Record<string, unknown> = {};

		// Add missing enrichment fields
		if (!('result' in b)) { updates.result = null; changed = true; }
		if (!('subActivities' in b)) { updates.subActivities = []; changed = true; }
		if (!('skillPrompt' in b)) { updates.skillPrompt = null; changed = true; }
		if (!('interrupted' in b)) { updates.interrupted = false; changed = true; }

		// Normalize tool name
		const rawName = (b.name as string) || '';
		if (isOpenCode) {
			if (isOpenCodeToolName(rawName)) {
				const normalizedName = normalizeOpenCodeToolName(rawName);
				if (normalizedName !== rawName) { updates.name = normalizedName; changed = true; }
			}
		} else {
			const normalizedName = normalizeClaudeToolName(rawName);
			if (normalizedName !== rawName) { updates.name = normalizedName; changed = true; }
		}

		// Normalize tool input (only if has snake_case/dash keys)
		const input = (b.input as Record<string, unknown>) || {};
		if (hasSnakeCaseKeys(input)) {
			const effectiveName = (updates.name as string) || rawName;
			updates.input = isOpenCode
				? convertOpenCodeToolInput(effectiveName, input)
				: convertClaudeToolInput(rawName, input);
			changed = true;
		}

		return { ...b, ...updates };
	});
	return { changed, content: enriched };
}

/** Enrich user content — fix snake_case fields and nested source blocks */
function enrichUserContent(content: unknown[]): { changed: boolean; content: unknown[] } {
	let changed = false;
	const enriched = content.map((block: unknown) => {
		const b = block as Record<string, unknown>;

		// Fix tool_result with snake_case tool_use_id → camelCase toolUseId
		if (b.type === 'tool_result' && 'tool_use_id' in b && !('toolUseId' in b)) {
			changed = true;
			return {
				type: 'tool_result',
				toolUseId: b.tool_use_id as string,
				content: typeof b.content === 'string'
					? b.content
					: JSON.stringify(b.content ?? ''),
				isError: !!((b.is_error ?? b.isError)),
			};
		}

		// Fix image with nested source → flat mediaType/data
		if (b.type === 'image' && 'source' in b && !('mediaType' in b)) {
			changed = true;
			const source = b.source as Record<string, unknown> | undefined;
			return {
				type: 'image',
				mediaType: (source?.media_type as string) || 'image/png',
				data: (source?.data as string) || '',
			};
		}

		// Fix document with nested source → flat mediaType/data
		if (b.type === 'document' && 'source' in b && !('mediaType' in b)) {
			changed = true;
			const source = b.source as Record<string, unknown> | undefined;
			return {
				type: 'document',
				mediaType: (source?.media_type as string) || '',
				data: (source?.data as string) || '',
				title: (b.title as string) || null,
			};
		}

		return b;
	});
	return { changed, content: enriched };
}

/** Map stop reason based on engine — OpenCode uses different values */
function normalizeStopReason(raw: string | null | undefined, engine: string): string | null {
	if (!raw) return null;
	if (engine === 'opencode') return mapOpenCodeStopReason(raw);
	return mapClaudeStopReason(raw);
}

/** Deep-enrich an already-unified message */
function deepEnrich(msg: Record<string, unknown>, sessionEngine: string): boolean {
	let changed = false;
	const engine = (msg.engine as string) || sessionEngine;

	// Ensure engine is set
	if (!msg.engine) {
		msg.engine = sessionEngine;
		changed = true;
	}

	const msgType = msg.type as string;

	if (msgType === 'assistant') {
		// Normalize stop reason
		const rawStop = msg.stopReason as string | null | undefined;
		const normalized = normalizeStopReason(rawStop, engine);
		if (rawStop !== normalized) {
			msg.stopReason = normalized;
			changed = true;
		}

		// Enrich content blocks (engine-aware)
		const content = msg.content as unknown[];
		if (Array.isArray(content)) {
			const result = enrichAssistantContent(content, engine);
			if (result.changed) {
				msg.content = result.content;
				changed = true;
			}
		}
	}

	if (msgType === 'user') {
		const content = msg.content as unknown[];
		if (Array.isArray(content)) {
			const result = enrichUserContent(content);
			if (result.changed) {
				msg.content = result.content;
				changed = true;
			}
		}
	}

	return changed;
}

// ============================================================
// Migration Entry Points
// ============================================================

export const up = (db: DatabaseConnection): void => {
	// ── Build session_id → engine map from chat_sessions ──
	const sessionEngineMap = new Map<string, string>();
	const sessions = db.prepare('SELECT id, engine FROM chat_sessions').all() as { id: string; engine: string | null }[];
	for (const s of sessions) {
		sessionEngineMap.set(s.id, s.engine || 'claude-code');
	}

	// ── Phase 1: Deep-convert old format + sync already-unified ──
	debug.log('migration', 'Phase 1: Deep-converting sdk_message JSON to unified format...');

	const rows = db.prepare('SELECT id, session_id, timestamp, sdk_message, sender_id, sender_name, parent_message_id FROM messages').all() as OldRow[];
	const updateStmt = db.prepare('UPDATE messages SET sdk_message = ? WHERE id = ?');
	const insertStmt = db.prepare('INSERT OR IGNORE INTO messages (id, session_id, timestamp, sdk_message, sender_id, sender_name, parent_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)');

	let convertedCount = 0;
	let syncedCount = 0;
	let extraCount = 0;

	for (const row of rows) {
		const raw = JSON.parse(row.sdk_message) as Record<string, unknown>;
		const sessionEngine = sessionEngineMap.get(row.session_id) || 'claude-code';

		if (isOldSdkFormat(raw)) {
			const results = convertOldFormat(raw, row, sessionEngine);
			updateStmt.run(JSON.stringify(results[0]), row.id);
			for (let i = 1; i < results.length; i++) {
				const extra = results[i];
				insertStmt.run(
					extra.messageId as string,
					row.session_id,
					row.timestamp,
					JSON.stringify(extra),
					row.sender_id,
					row.sender_name,
					row.parent_message_id,
				);
				extraCount++;
			}
			convertedCount++;
		} else {
			const synced = syncMetadata(raw, row, sessionEngine);
			updateStmt.run(JSON.stringify(synced), row.id);
			syncedCount++;
		}
	}

	debug.log('migration', `Phase 1 complete: ${convertedCount} converted, ${syncedCount} synced, ${extraCount} extra (${rows.length} total)`);

	// ── Phase 2: Schema changes ──
	debug.log('migration', 'Phase 2: Renaming columns and dropping sender columns...');

	db.exec(`ALTER TABLE messages RENAME COLUMN sdk_message TO data`);

	db.exec(`DROP INDEX IF EXISTS idx_messages_timestamp`);
	db.exec(`ALTER TABLE messages RENAME COLUMN timestamp TO created_at`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);

	db.exec(`DROP INDEX IF EXISTS idx_messages_sender_id`);
	db.exec(`ALTER TABLE messages DROP COLUMN sender_id`);
	db.exec(`ALTER TABLE messages DROP COLUMN sender_name`);

	debug.log('migration', 'Phase 2 complete: columns renamed, sender columns dropped');

	// ── Phase 3: Deep-enrich all unified messages (both engines) ──
	debug.log('migration', 'Phase 3: Deep-enriching unified messages for both engines...');

	const newRows = db.prepare('SELECT id, session_id, data, parent_message_id FROM messages').all() as NewRow[];

	// Build messageId → sessionId map for parent.sessionId resolution
	// Build session_id → model map from assistant/reasoning messages (real SDK model ID)
	const sessionIdMap = new Map<string, string>();
	const realModelMap = new Map<string, string>();
	for (const row of newRows) {
		const msg = JSON.parse(row.data) as Record<string, unknown>;
		if (msg.sessionId) {
			sessionIdMap.set(row.id, msg.sessionId as string);
		}
		if (msg.model && (msg.type === 'assistant' || msg.type === 'reasoning')) {
			realModelMap.set(row.session_id, msg.model as string);
		}
	}

	const enrichStmt = db.prepare('UPDATE messages SET data = ? WHERE id = ?');
	let enrichedCount = 0;

	for (const row of newRows) {
		const msg = JSON.parse(row.data) as Record<string, unknown>;
		const sessionEngine = sessionEngineMap.get(row.session_id) || 'claude-code';
		let changed = deepEnrich(msg, sessionEngine);

		// Fill model from assistant/reasoning messages in same session (real SDK model ID)
		if (!msg.model) {
			const realModel = realModelMap.get(row.session_id);
			if (realModel) {
				msg.model = realModel;
				changed = true;
			}
		}

		// Resolve parent.sessionId from parent message's sessionId (SDK session)
		const parent = msg.parent as Record<string, unknown> | undefined;
		if (parent && row.parent_message_id && !parent.sessionId) {
			const parentSessionId = sessionIdMap.get(row.parent_message_id);
			if (parentSessionId) {
				parent.sessionId = parentSessionId;
				changed = true;
			}
		}

		if (changed) {
			enrichStmt.run(JSON.stringify(msg), row.id);
			enrichedCount++;
		}
	}

	debug.log('migration', `Phase 3 complete: ${enrichedCount} messages enriched (${newRows.length} total)`);
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Reverting column renames...');
	db.exec(`ALTER TABLE messages RENAME COLUMN data TO sdk_message`);

	db.exec(`DROP INDEX IF EXISTS idx_messages_created_at`);
	db.exec(`ALTER TABLE messages RENAME COLUMN created_at TO timestamp`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);

	db.exec(`ALTER TABLE messages ADD COLUMN sender_id TEXT`);
	db.exec(`ALTER TABLE messages ADD COLUMN sender_name TEXT`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id)`);

	debug.log('migration', 'Columns reverted (data conversion is irreversible)');
};
