import { open, readFile, readdir, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineOutput } from '$shared/types/unified';
import { convertAssistantMessage, convertUserMessage } from './message-converter';

interface WorkflowTranscript {
	parentToolUseId: string;
	directory: string;
	statusPath: string;
	sessionId: string;
	offsets: Map<string, number>;
}

interface RawTranscriptEntry {
	type?: string;
	uuid?: string;
	timestamp?: string;
	message?: {
		content?: unknown;
		model?: string;
		stop_reason?: string | null;
		usage?: unknown;
	};
}

function workflowRegistration(msg: SDKMessage, workflowToolUseIds: Set<string>): Omit<WorkflowTranscript, 'offsets'> | null {
	if (msg.type !== 'user' || !Array.isArray(msg.message.content)) return null;

	for (const block of msg.message.content as unknown as Array<Record<string, unknown>>) {
		if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
		if (!block.content.startsWith('Workflow launched in background.')) continue;

		const directory = block.content.match(/^Transcript dir:\s*(.+)$/m)?.[1]?.trim();
		const runId = block.content.match(/^Run ID:\s*(.+)$/m)?.[1]?.trim();
		const parentToolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
		if (directory && runId && workflowToolUseIds.has(parentToolUseId)) {
			const sessionDirectory = dirname(dirname(dirname(directory)));
			return {
				parentToolUseId,
				directory,
				statusPath: join(sessionDirectory, 'workflows', `${basename(runId)}.json`),
				sessionId: msg.session_id || '',
			};
		}
	}

	return null;
}

function convertEntry(entry: RawTranscriptEntry, workflow: WorkflowTranscript): EngineOutput[] {
	if (!entry.message || !entry.uuid) return [];
	const preserveTimestamp = (outputs: EngineOutput[]): EngineOutput[] => {
		if (!entry.timestamp) return outputs;
		return outputs.map(output => {
			if (output.type !== 'assistant' && output.type !== 'user') return output;
			return { ...output, createdAt: entry.timestamp as string };
		});
	};

	if (entry.type === 'assistant' && Array.isArray(entry.message.content)) {
		const visibleContent = entry.message.content.filter((block: unknown) => {
			if (!block || typeof block !== 'object') return false;
			const type = (block as { type?: string }).type;
			return type === 'text' || type === 'tool_use';
		});
		if (visibleContent.length === 0) return [];

		return preserveTimestamp(convertAssistantMessage({
			type: 'assistant',
			uuid: entry.uuid,
			session_id: workflow.sessionId,
			parent_tool_use_id: workflow.parentToolUseId,
			message: { ...entry.message, content: visibleContent },
		} as Parameters<typeof convertAssistantMessage>[0]));
	}

	if (entry.type === 'user' && Array.isArray(entry.message.content)) {
		const toolResults = entry.message.content.filter((block: unknown) => (
			Boolean(block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result')
		));
		if (toolResults.length === 0) return [];

		return preserveTimestamp([convertUserMessage({
			type: 'user',
			uuid: entry.uuid,
			session_id: workflow.sessionId,
			parent_tool_use_id: workflow.parentToolUseId,
			message: { role: 'user', content: toolResults },
		} as Parameters<typeof convertUserMessage>[0])]);
	}

	return [];
}

async function readAppendedLines(path: string, offset: number): Promise<{ lines: string[]; offset: number }> {
	const info = await stat(path);
	if (info.size <= offset) return { lines: [], offset };

	const handle = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(info.size - offset);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
		const chunk = buffer.subarray(0, bytesRead).toString('utf8');
		const lastNewline = chunk.lastIndexOf('\n');
		if (lastNewline < 0) return { lines: [], offset };

		return {
			lines: chunk.slice(0, lastNewline).split('\n').filter(Boolean),
			offset: offset + Buffer.byteLength(chunk.slice(0, lastNewline + 1)),
		};
	} finally {
		await handle.close();
	}
}

/** Incrementally replays Workflow-owned agent transcripts into the Workflow parent. */
export class WorkflowTranscriptTailer {
	private workflows = new Map<string, WorkflowTranscript>();
	private workflowToolUseIds = new Set<string>();
	private watchers = new Map<string, FSWatcher>();
	private waiters = new Set<() => void>();
	private version = 0;

	get changeVersion(): number {
		return this.version;
	}

	private signalChange(): void {
		this.version += 1;
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const resolve of waiters) resolve();
	}

	private watchPath(path: string): void {
		if (this.watchers.has(path)) return;
		try {
			const watcher = watch(path, { persistent: false }, () => this.signalChange());
			watcher.on('error', () => {
				watcher.close();
				this.watchers.delete(path);
				this.signalChange();
			});
			this.watchers.set(path, watcher);
		} catch {
			// A final drain still captures files created before the watcher attaches.
		}
	}

	wake(): void {
		this.signalChange();
	}

	async waitForChange(afterVersion: number, signal: AbortSignal): Promise<void> {
		if (this.version !== afterVersion || signal.aborted) return;
		await new Promise<void>(resolve => {
			const finish = () => {
				this.waiters.delete(finish);
				signal.removeEventListener('abort', finish);
				resolve();
			};
			this.waiters.add(finish);
			signal.addEventListener('abort', finish, { once: true });
			// Close the race between the version check and waiter registration.
			if (this.version !== afterVersion) finish();
		});
	}

	observe(msg: SDKMessage): void {
		if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
			for (const block of msg.message.content) {
				if (block.type === 'tool_use' && block.name === 'Workflow') {
					this.workflowToolUseIds.add(block.id);
				}
			}
		}

		const registration = workflowRegistration(msg, this.workflowToolUseIds);
		if (registration && !this.workflows.has(registration.parentToolUseId)) {
			this.workflows.set(registration.parentToolUseId, { ...registration, offsets: new Map() });
			this.watchPath(registration.directory);
			this.watchPath(dirname(registration.statusPath));
			this.signalChange();
		}
	}

	async drain(): Promise<EngineOutput[]> {
		const entries: Array<{ entry: RawTranscriptEntry; workflow: WorkflowTranscript }> = [];
		for (const workflow of this.workflows.values()) {
			let files: string[];
			try {
				files = (await readdir(workflow.directory))
					.filter(name => name.startsWith('agent-') && name.endsWith('.jsonl'))
					.sort();
			} catch {
				continue;
			}

			for (const file of files) {
				const path = `${workflow.directory}/${file}`;
				const previousOffset = workflow.offsets.get(path) || 0;
				try {
					const appended = await readAppendedLines(path, previousOffset);
					workflow.offsets.set(path, appended.offset);
					for (const line of appended.lines) {
						try {
							entries.push({ entry: JSON.parse(line) as RawTranscriptEntry, workflow });
						} catch {
							// A malformed transcript record must not interrupt the chat stream.
						}
					}
				} catch {
					// Agent files are created and appended concurrently by Claude Code.
				}
			}
		}

		entries.sort((a, b) => (a.entry.timestamp || '').localeCompare(b.entry.timestamp || ''));
		return entries.flatMap(({ entry, workflow }) => convertEntry(entry, workflow));
	}

	async hasActiveWorkflows(): Promise<boolean> {
		for (const workflow of this.workflows.values()) {
			try {
				const state = JSON.parse(await readFile(workflow.statusPath, 'utf8')) as { status?: string };
				const terminal = new Set(['complete', 'completed', 'success', 'failed', 'error', 'killed', 'cancelled']);
				if (!state.status || !terminal.has(state.status.toLowerCase())) return true;
			} catch {
				// The run status file is written when the background Workflow settles.
				return true;
			}
		}
		return false;
	}

	async capture(msg: SDKMessage): Promise<EngineOutput[]> {
		this.observe(msg);
		return this.drain();
	}

	dispose(): void {
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
		this.signalChange();
	}
}
