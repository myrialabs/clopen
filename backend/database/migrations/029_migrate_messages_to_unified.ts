import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Deep-convert messages to unified format, enrich both engines, rename columns, drop sender columns, rename session columns, and unify engine providers/accounts tables';

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
		engine: { type: engine, provider: '', model: { id: model || '', name: '' }, account: { id: 0, name: '' } },
		sender: {
			id: row.sender_id || '',
			name: row.sender_name || '',
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
		id: row.sender_id || (raw.sender as Record<string, unknown>)?.id || '',
		name: row.sender_name || (raw.sender as Record<string, unknown>)?.name || '',
	};

	// Migrate flat engine/model/account → nested engine: { type, model, account }
	if (raw.engine && typeof raw.engine === 'string') {
		// Old flat format → restructure
		const oldEngine = raw.engine as string;
		const oldModel = raw.model as string | null;
		const rawAccount = (raw.account as Record<string, unknown>) || {};
		const oldAccount = { id: (rawAccount.id as number) || 0, name: (rawAccount.name as string) || '' };
		raw.engine = { type: oldEngine, provider: '', model: { id: oldModel || '', name: '' }, account: oldAccount };
		delete raw.model;
		delete raw.account;
	} else if (!raw.engine) {
		raw.engine = { type: sessionEngine, provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } };
	}
	// Ensure engine.provider exists
	const engineObj = raw.engine as Record<string, unknown>;
	if (!('provider' in engineObj)) engineObj.provider = '';
	// Ensure engine.account exists
	if (!engineObj.account) engineObj.account = { id: 0, name: '' };

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

	// Migrate flat engine/model → nested format if still in old format
	if (msg.engine && typeof msg.engine === 'string') {
		const oldEngine = msg.engine as string;
		const oldModel = msg.model as string | null;
		const rawAccount = (msg.account as Record<string, unknown>) || {};
		const oldAccount = { id: (rawAccount.id as number) || 0, name: (rawAccount.name as string) || '' };
		msg.engine = { type: oldEngine, provider: '', model: { id: oldModel || '', name: '' }, account: oldAccount };
		delete msg.model;
		delete msg.account;
		changed = true;
	}

	// Ensure engine object exists
	if (!msg.engine) {
		msg.engine = { type: sessionEngine, provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } };
		changed = true;
	}

	// Ensure engine.provider exists
	const engineForProviderCheck = msg.engine as Record<string, unknown>;
	if (!('provider' in engineForProviderCheck)) {
		engineForProviderCheck.provider = '';
		changed = true;
	}

	// Migrate engine.model from flat string to object format
	if (engineForProviderCheck.model && typeof engineForProviderCheck.model === 'string') {
		engineForProviderCheck.model = { id: engineForProviderCheck.model, name: '' };
		changed = true;
	} else if (!engineForProviderCheck.model) {
		engineForProviderCheck.model = { id: '', name: '' };
		changed = true;
	}

	const engineObj = msg.engine as Record<string, unknown>;
	const engine = (engineObj.type as string) || sessionEngine;

	// Ensure engine.account exists
	if (!engineObj.account) {
		engineObj.account = { id: 0, name: '' };
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
// Text Extraction (for backfill)
// ============================================================

/** Extract first text content from a unified message data blob */
function extractTextFromData(msg: Record<string, unknown>): string {
	if (msg.type === 'reasoning') return (msg.text as string) || '';
	if (msg.type === 'compact_boundary') return '';
	const content = msg.content;
	if (!Array.isArray(content)) return '';
	for (const block of content as Record<string, unknown>[]) {
		if (block.type === 'text' && block.text) return (block.text as string);
	}
	return '';
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
		// Extract model from engine object (new format) or flat field (old format)
		const msgEngine = msg.engine as Record<string, unknown> | string | null;
		let msgModelId: string | null = null;
		if (typeof msgEngine === 'object' && msgEngine) {
			const modelField = msgEngine.model;
			if (typeof modelField === 'object' && modelField) {
				msgModelId = (modelField as Record<string, unknown>).id as string | null;
			} else if (typeof modelField === 'string') {
				msgModelId = modelField;
			}
		} else {
			msgModelId = (msg.model as string | null);
		}
		if (msgModelId && (msg.type === 'assistant' || msg.type === 'reasoning')) {
			realModelMap.set(row.session_id, msgModelId);
		}
	}

	const enrichStmt = db.prepare('UPDATE messages SET data = ? WHERE id = ?');
	let enrichedCount = 0;

	for (const row of newRows) {
		const msg = JSON.parse(row.data) as Record<string, unknown>;
		const sessionEngine = sessionEngineMap.get(row.session_id) || 'claude-code';
		let changed = deepEnrich(msg, sessionEngine);

		// Fill model from assistant/reasoning messages in same session (real SDK model ID)
		const enrichedEngine = msg.engine as Record<string, unknown>;
		const modelObj = enrichedEngine.model as Record<string, unknown> | null;
		if (!modelObj || !modelObj.id) {
			const realModel = realModelMap.get(row.session_id);
			if (realModel) {
				enrichedEngine.model = { id: realModel, name: '' };
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

	// ── Phase 4: Rename session columns to engine-agnostic names ──
	debug.log('migration', 'Phase 4: Renaming chat_sessions columns...');
	db.exec(`ALTER TABLE chat_sessions RENAME COLUMN claude_account_id TO account_id`);
	db.exec(`ALTER TABLE chat_sessions RENAME COLUMN latest_sdk_session_id TO head_session_id`);
	db.exec(`ALTER TABLE chat_sessions RENAME COLUMN current_head_message_id TO head_message_id`);

	// Rename model → model_id and add model_name, provider
	db.exec(`ALTER TABLE chat_sessions RENAME COLUMN model TO model_id`);
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN model_name TEXT`);
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN provider TEXT`);

	// Strip compound ID prefix (e.g., 'claude-code:sonnet' → 'sonnet')
	db.exec(`
		UPDATE chat_sessions
		SET model_id = CASE
			WHEN model_id LIKE '%:%' THEN SUBSTR(model_id, INSTR(model_id, ':') + 1)
			ELSE model_id
		END
		WHERE model_id IS NOT NULL
	`);

	debug.log('migration', 'Phase 4 complete: chat_sessions columns renamed');

	// ── Phase 5: Enrich chat_sessions with HEAD snapshot, counts, sender ──
	debug.log('migration', 'Phase 5: Adding session metadata columns and backfilling...');

	db.exec(`ALTER TABLE chat_sessions ADD COLUMN account_name TEXT`);
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN sender_id TEXT`);
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN sender_name TEXT`);
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN head_title TEXT`);
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN head_summary TEXT`);
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN message_count INTEGER DEFAULT 0`);
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN user_count INTEGER DEFAULT 0`);
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN last_message_at TEXT`);

	// Backfill from existing messages
	const backfillSessions = db.prepare('SELECT id, head_message_id FROM chat_sessions').all() as {
		id: string;
		head_message_id: string | null;
	}[];

	const backfillUpdate = db.prepare(`
		UPDATE chat_sessions
		SET title = ?, head_title = ?, head_summary = ?,
		    message_count = ?, user_count = ?,
		    sender_id = ?, sender_name = ?,
		    last_message_at = ?
		WHERE id = ?
	`);

	let backfilledCount = 0;

	for (const session of backfillSessions) {
		// Get counts
		const counts = db.prepare(`
			SELECT
				COUNT(*) AS total,
				SUM(CASE WHEN json_extract(data, '$.type') = 'user' THEN 1 ELSE 0 END) AS user_count
			FROM messages WHERE session_id = ?
		`).get(session.id) as { total: number; user_count: number } | null;

		if (!counts || counts.total === 0) continue;

		// Get first user message for title
		const firstUser = db.prepare(`
			SELECT data FROM messages
			WHERE session_id = ? AND json_extract(data, '$.type') = 'user'
			ORDER BY created_at ASC LIMIT 1
		`).get(session.id) as { data: string } | null;

		let title: string | null = null;
		if (firstUser) {
			const msg = JSON.parse(firstUser.data) as Record<string, unknown>;
			const text = extractTextFromData(msg);
			if (text) {
				title = text.slice(0, 80) + (text.length > 80 ? '...' : '');
			}
		}

		// Walk HEAD chain for head_title and head_summary
		let headTitle: string | null = null;
		let headSummary: string | null = null;

		if (session.head_message_id) {
			const msgLookup = new Map<string, { data: string; parent_message_id: string | null }>();
			const allMsgs = db.prepare(
				'SELECT id, data, parent_message_id FROM messages WHERE session_id = ?'
			).all(session.id) as { id: string; data: string; parent_message_id: string | null }[];
			for (const m of allMsgs) {
				msgLookup.set(m.id, m);
			}

			let walkId: string | null = session.head_message_id;
			while (walkId) {
				const row = msgLookup.get(walkId);
				if (!row) break;
				const msg = JSON.parse(row.data) as Record<string, unknown>;
				const msgType = msg.type as string;

				if (!headSummary && msgType === 'assistant') {
					const text = extractTextFromData(msg);
					const clean = text.replace(/```[\s\S]*?```/g, '').trim();
					if (clean) {
						headSummary = clean.slice(0, 200) + (clean.length > 200 ? '...' : '');
					}
				}
				if (!headTitle && msgType === 'user') {
					const text = extractTextFromData(msg);
					if (text) {
						headTitle = text.slice(0, 80) + (text.length > 80 ? '...' : '');
					}
				}
				if (headTitle && headSummary) break;
				walkId = row.parent_message_id;
			}
		}

		// Get last message sender and timestamp
		const lastMsg = db.prepare(`
			SELECT data, created_at FROM messages
			WHERE session_id = ?
			ORDER BY created_at DESC LIMIT 1
		`).get(session.id) as { data: string; created_at: string } | null;

		let senderId: string | null = null;
		let senderName: string | null = null;
		let lastMessageAt: string | null = null;

		if (lastMsg) {
			const msg = JSON.parse(lastMsg.data) as Record<string, unknown>;
			const sender = msg.sender as Record<string, unknown> | undefined;
			senderId = (sender?.id as string) || null;
			senderName = (sender?.name as string) || null;
			lastMessageAt = lastMsg.created_at;
		}

		backfillUpdate.run(
			title, headTitle, headSummary,
			counts.total, counts.user_count,
			senderId, senderName,
			lastMessageAt,
			session.id
		);
		backfilledCount++;
	}

	debug.log('migration', `Phase 5 complete: ${backfilledCount} sessions backfilled (${backfillSessions.length} total)`);

	// ── Phase 6: Create unified engine_providers / engine_accounts tables ──
	debug.log('migration', 'Phase 6: Creating unified engine_providers / engine_accounts tables...');

	// engine_providers: one row per (engine_type, slug).
	//   - slug        = machine id (e.g. 'anthropic', 'openai'). Always lowercase.
	//   - name        = display name (e.g. 'Anthropic', 'OpenAI').
	//   - npm         = npm package for opencode providers (null for claude-code).
	//   - api_url     = optional custom API endpoint.
	//   - options     = provider-specific JSON (extra env vars, flags, etc).
	//   - is_enabled  = whether the provider shows up to the user.
	db.exec(`
		CREATE TABLE IF NOT EXISTS engine_providers (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			engine_type TEXT NOT NULL,
			slug        TEXT NOT NULL,
			name        TEXT NOT NULL,
			npm         TEXT,
			api_url     TEXT,
			options     TEXT NOT NULL DEFAULT '{}',
			is_enabled  INTEGER NOT NULL DEFAULT 1,
			created_at  TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE (engine_type, slug)
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_engine_providers_engine_type ON engine_providers(engine_type)`);

	// engine_accounts: credentials under a provider.
	//   - credential = generic secret (OAuth token for claude-code, API key for opencode).
	db.exec(`
		CREATE TABLE IF NOT EXISTS engine_accounts (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			provider_id INTEGER NOT NULL,
			name        TEXT NOT NULL,
			credential  TEXT NOT NULL,
			is_active   INTEGER NOT NULL DEFAULT 0,
			created_at  TEXT NOT NULL DEFAULT (datetime('now')),
			FOREIGN KEY (provider_id) REFERENCES engine_providers(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_engine_accounts_provider_id ON engine_accounts(provider_id)`);

	debug.log('migration', 'Phase 6 complete: unified tables created');

	// ── Phase 7: Migrate data into unified tables ──
	debug.log('migration', 'Phase 7: Migrating data into engine_providers / engine_accounts...');

	// 7a. Seed claude-code / anthropic provider (single row).
	db.prepare(`
		INSERT OR IGNORE INTO engine_providers (engine_type, slug, name, npm, api_url, options, is_enabled)
		VALUES ('claude-code', 'anthropic', 'Anthropic', NULL, NULL, '{}', 1)
	`).run();

	const anthropicProvider = db.prepare(`
		SELECT id FROM engine_providers WHERE engine_type = 'claude-code' AND slug = 'anthropic'
	`).get() as { id: number } | null;
	const anthropicProviderId = anthropicProvider?.id ?? null;

	// 7b. Migrate claude_accounts → engine_accounts (linked to anthropic).
	const hasClaudeAccounts = db.prepare(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'claude_accounts'`
	).get() as { name: string } | undefined;

	let migratedClaudeAccounts = 0;
	if (hasClaudeAccounts && anthropicProviderId !== null) {
		const claudeRows = db.prepare(
			`SELECT id, name, oauth_token, is_active, created_at FROM claude_accounts ORDER BY created_at ASC`
		).all() as { id: number; name: string; oauth_token: string; is_active: number; created_at: string }[];

		const insertClaudeAccount = db.prepare(`
			INSERT INTO engine_accounts (provider_id, name, credential, is_active, created_at)
			VALUES (?, ?, ?, ?, ?)
		`);

		for (const row of claudeRows) {
			insertClaudeAccount.run(anthropicProviderId, row.name, row.oauth_token, row.is_active, row.created_at);
			migratedClaudeAccounts++;
		}
	}

	// 7c. Migrate opencode_providers → engine_providers.
	// We need a map from old opencode_providers.id → new engine_providers.id
	const hasOpenCodeProviders = db.prepare(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'opencode_providers'`
	).get() as { name: string } | undefined;

	const opencodeProviderIdMap = new Map<number, number>();
	let migratedOpenCodeProviders = 0;
	if (hasOpenCodeProviders) {
		const ocProviderRows = db.prepare(
			`SELECT id, provider_id, name, npm, api_url, options, is_enabled, created_at FROM opencode_providers ORDER BY created_at ASC`
		).all() as {
			id: number;
			provider_id: string;
			name: string;
			npm: string;
			api_url: string | null;
			options: string;
			is_enabled: number;
			created_at: string;
		}[];

		const insertOcProvider = db.prepare(`
			INSERT INTO engine_providers (engine_type, slug, name, npm, api_url, options, is_enabled, created_at)
			VALUES ('opencode', ?, ?, ?, ?, ?, ?, ?)
		`);

		for (const row of ocProviderRows) {
			const result = insertOcProvider.run(
				row.provider_id,
				row.name,
				row.npm || null,
				row.api_url,
				row.options || '{}',
				row.is_enabled,
				row.created_at,
			) as { lastInsertRowid: number | bigint };
			const newId = Number(result.lastInsertRowid);
			opencodeProviderIdMap.set(row.id, newId);
			migratedOpenCodeProviders++;
		}
	}

	// 7d. Migrate opencode_accounts → engine_accounts (with remapped provider_id).
	const hasOpenCodeAccounts = db.prepare(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'opencode_accounts'`
	).get() as { name: string } | undefined;

	let migratedOpenCodeAccounts = 0;
	if (hasOpenCodeAccounts) {
		const ocAccountRows = db.prepare(
			`SELECT id, provider_id, name, api_key, is_active, created_at FROM opencode_accounts ORDER BY created_at ASC`
		).all() as {
			id: number;
			provider_id: number;
			name: string;
			api_key: string;
			is_active: number;
			created_at: string;
		}[];

		const insertOcAccount = db.prepare(`
			INSERT INTO engine_accounts (provider_id, name, credential, is_active, created_at)
			VALUES (?, ?, ?, ?, ?)
		`);

		for (const row of ocAccountRows) {
			const newProviderId = opencodeProviderIdMap.get(row.provider_id);
			if (newProviderId === undefined) continue; // orphan — skip
			insertOcAccount.run(newProviderId, row.name, row.api_key, row.is_active, row.created_at);
			migratedOpenCodeAccounts++;
		}
	}

	debug.log(
		'migration',
		`Phase 7 complete: ${migratedClaudeAccounts} claude accounts, ${migratedOpenCodeProviders} opencode providers, ${migratedOpenCodeAccounts} opencode accounts migrated`
	);

	// ── Phase 8: Drop legacy tables ──
	debug.log('migration', 'Phase 8: Dropping legacy claude_accounts / opencode_* tables...');
	db.exec(`DROP TABLE IF EXISTS opencode_accounts`);
	db.exec(`DROP TABLE IF EXISTS opencode_providers`);
	db.exec(`DROP TABLE IF EXISTS claude_accounts`);
	debug.log('migration', 'Phase 8 complete: legacy tables dropped');
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

	// Revert Phase 5: drop session metadata columns
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN account_name`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN sender_id`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN sender_name`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN head_title`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN head_summary`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN message_count`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN user_count`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN last_message_at`);

	// Revert session column renames
	db.exec(`ALTER TABLE chat_sessions RENAME COLUMN account_id TO claude_account_id`);
	db.exec(`ALTER TABLE chat_sessions RENAME COLUMN head_session_id TO latest_sdk_session_id`);
	db.exec(`ALTER TABLE chat_sessions RENAME COLUMN head_message_id TO current_head_message_id`);
	db.exec(`ALTER TABLE chat_sessions RENAME COLUMN model_id TO model`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN model_name`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN provider`);

	debug.log('migration', 'Columns reverted (data conversion is irreversible)');

	// Revert Phase 6-8: drop unified tables (data loss — cannot safely rebuild
	// the original split tables from the merged data).
	db.exec(`DROP TABLE IF EXISTS engine_accounts`);
	db.exec(`DROP TABLE IF EXISTS engine_providers`);
	debug.log('migration', 'Unified engine tables dropped (original split tables are not restored)');
};
