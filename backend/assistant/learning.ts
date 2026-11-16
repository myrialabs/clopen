/**
 * The learning loop — noticing repetition and turning it into something
 * reusable, so the same work stops being redone by hand or paid for in tokens.
 *
 * Two signals, both observed from the stream every engine already produces:
 *
 * - Command sequences. The shell commands an agent runs in one turn are
 *   reduced to the meaningful ones (builds, tests, migrations, restarts —
 *   never `ls`/`cat`/`grep`, which are reading, not doing) and every run of 2–4
 *   consecutive ones is counted. A sequence seen in three turns across at
 *   least two sessions becomes a script: saved automatically when the
 *   assistant is autonomous, suggested in the Inbox when it asks first.
 *
 * - Requests. The owner's own prompts are compared by word overlap; three
 *   alike, from at least two sessions, mean a procedure worth keeping. Writing
 *   a good skill needs judgement, so the assistant is asked to write it (or,
 *   asking first, the owner is offered that).
 *
 * State is small and bounded, and kept in one settings row so it survives a
 * restart without a table of its own.
 */

import { settingsQueries, scriptQueries } from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { isAssistantProject } from '$shared/utils/assistant-project';
import { projectQueries } from '$backend/database/queries';
import type { StreamEvent } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { getAssistantSettings } from './settings';
import { raiseInboxItem } from './inbox';
import { saveScript, slugify } from './scripts';
import { askAssistant } from './ask';

const STATE_KEY = 'assistant:learning';
const SEQUENCE_THRESHOLD = 3;
const PROMPT_THRESHOLD = 3;
const PROMPT_SIMILARITY = 0.55;
const MAX_SEQUENCES = 400;
const MAX_PROMPTS = 300;

interface SequenceStat {
	projectId: string;
	commands: string[];
	count: number;
	sessions: string[];
	lastAt: number;
	offered: boolean;
}

interface PromptStat {
	text: string;
	tokens: string[];
	sessionId: string;
	projectId: string;
	at: number;
}

interface LearningState {
	sequences: Record<string, SequenceStat>;
	prompts: PromptStat[];
	offeredPrompts: string[];
}

let state: LearningState | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): LearningState {
	if (state) return state;
	try {
		const raw = settingsQueries.get(STATE_KEY)?.value;
		const parsed = raw ? JSON.parse(raw) : null;
		state = {
			sequences: parsed?.sequences && typeof parsed.sequences === 'object' ? parsed.sequences : {},
			prompts: Array.isArray(parsed?.prompts) ? parsed.prompts : [],
			offeredPrompts: Array.isArray(parsed?.offeredPrompts) ? parsed.offeredPrompts : []
		};
	} catch {
		state = { sequences: {}, prompts: [], offeredPrompts: [] };
	}
	return state;
}

function persist(): void {
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		if (!state) return;
		try {
			settingsQueries.set(STATE_KEY, JSON.stringify(state));
		} catch (error) {
			debug.warn('assistant', 'Saving the learning state failed:', error);
		}
	}, 5000);
}

// ── Commands ───────────────────────────────────────────────────────────────

const SHELL_TOOLS = /^(bash|shell|run_shell_command|exec_command|execute_command|exec|terminal|run_terminal_cmd)$/i;

/** Reading and inspecting — useful, but never what a script is for. */
const TRIVIAL = /^(ls|ll|cat|head|tail|less|more|sed|grep|rg|ag|find|fd|echo|printf|pwd|which|whereis|type|wc|sort|uniq|awk|cut|tr|diff|stat|file|tree|du|df|env|printenv|true|false|sleep|cd|clear|history|man|open|code|python3?|node|bun -e|jq|curl -s[^ ]* http:\/\/localhost)\b/;
const TRIVIAL_GIT = /^git (status|log|diff|show|branch|remote|rev-parse|ls-files|blame|reflog|stash list|config --get)\b/;

/** One command as it is counted: no leading `cd x &&`, no output plumbing, single-spaced. */
export function normaliseCommand(raw: string): string | null {
	if (!raw || raw.includes('\n') || raw.includes('<<') || raw.length > 300) return null;
	let command = raw.trim();
	command = command.replace(/^cd\s+\S+\s*(&&|;)\s*/, '');
	command = command.replace(/\s+2>&1\b/g, '').replace(/\s*\|\s*(head|tail)(\s+-n?\s*\d+)?\s*$/, '');
	command = command.replace(/\s+/g, ' ').trim();
	if (!command || TRIVIAL.test(command) || TRIVIAL_GIT.test(command)) return null;
	return command;
}

/** Every run of 2–4 consecutive commands, deduplicated. */
export function sequencesOf(commands: string[]): string[][] {
	const out = new Map<string, string[]>();
	for (let size = 2; size <= 4; size++) {
		for (let start = 0; start + size <= commands.length; start++) {
			const run = commands.slice(start, start + size);
			if (new Set(run).size < run.length) continue;
			out.set(run.join('\u0000'), run);
		}
	}
	return [...out.values()];
}

/** Commands seen in the turn now running, per session. */
const turnCommands = new Map<string, { projectId: string; commands: string[] }>();

function onShellCommand(chatSessionId: string, projectId: string, raw: string): void {
	const command = normaliseCommand(raw);
	if (!command) return;
	const turn = turnCommands.get(chatSessionId) ?? { projectId, commands: [] };
	if (turn.commands[turn.commands.length - 1] !== command) turn.commands.push(command);
	turnCommands.set(chatSessionId, turn);
}

async function onTurnCommandsSettled(chatSessionId: string): Promise<void> {
	const turn = turnCommands.get(chatSessionId);
	turnCommands.delete(chatSessionId);
	if (!turn || turn.commands.length < 2) return;
	const learned = load();
	const now = Date.now();
	for (const run of sequencesOf(turn.commands)) {
		const key = `${turn.projectId}:${run.join('\u0000')}`;
		const stat = learned.sequences[key] ?? { projectId: turn.projectId, commands: run, count: 0, sessions: [], lastAt: now, offered: false };
		stat.count += 1;
		stat.lastAt = now;
		if (!stat.sessions.includes(chatSessionId)) stat.sessions = [...stat.sessions, chatSessionId].slice(-10);
		learned.sequences[key] = stat;
	}
	prune(learned);
	persist();

	// Offer the longest qualifying sequence of this turn, once.
	const ready = Object.values(learned.sequences)
		.filter((stat) => stat.projectId === turn.projectId && !stat.offered && stat.count >= SEQUENCE_THRESHOLD && stat.sessions.length >= 2)
		.sort((a, b) => b.commands.length - a.commands.length || b.count - a.count);
	const pick = ready[0];
	if (!pick) return;
	for (const stat of Object.values(learned.sequences)) {
		// A shorter run inside the one being offered is covered by it.
		if (stat.projectId === pick.projectId && pick.commands.join('\u0000').includes(stat.commands.join('\u0000'))) stat.offered = true;
	}
	persist();
	await offerScript(pick);
}

function prune(learned: LearningState): void {
	const entries = Object.entries(learned.sequences);
	if (entries.length <= MAX_SEQUENCES) return;
	entries.sort((a, b) => a[1].lastAt - b[1].lastAt);
	for (const [key] of entries.slice(0, entries.length - MAX_SEQUENCES)) delete learned.sequences[key];
}

export function scriptFromCommands(commands: string[]): string {
	return ['#!/usr/bin/env bash', '# Saved by Clopen from steps that kept being repeated.', 'set -euo pipefail', '', ...commands, ''].join('\n');
}

function scriptName(commands: string[]): string {
	const heads = commands.map((command) => command.split(' ').slice(0, 3).join(' '));
	return slugify(heads.join(' then ')).slice(0, 50);
}

async function offerScript(stat: SequenceStat): Promise<void> {
	const project = projectQueries.getById(stat.projectId);
	if (!project || isAssistantProject(project)) return;
	const name = scriptName(stat.commands);
	if (scriptQueries.getBySlug(slugify(name), project.id)) return;
	const listing = stat.commands.map((command) => `- \`${command}\``).join('\n');

	if (getAssistantSettings().autonomy === 'autonomous') {
		const script = saveScript({
			name,
			description: `Runs ${stat.commands.length} steps that were repeated ${stat.count} times in ${project.name}`,
			content: scriptFromCommands(stat.commands),
			projectId: project.id,
			source: 'detected'
		});
		raiseInboxItem({
			kind: 'learned',
			title: `New script: ${script.name}`,
			body: `These steps kept being repeated in ${project.name}, so they are now one script any agent or flow can run without spending tokens:\n\n${listing}`,
			data: { scriptId: script.id },
			projectId: project.id
		});
		return;
	}
	raiseInboxItem({
		kind: 'suggestion',
		title: `Save repeated steps as a script?`,
		body: `These steps were repeated ${stat.count} times in ${project.name}:\n\n${listing}`,
		data: { action: 'save-script', name, commands: stat.commands },
		projectId: project.id,
		dedupe: `script:${project.id}:${name}`
	});
}

// ── Requests ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
	'the and for with that this you your are was were have has can could would should will into from then them they what when where which while please just also like make sure about there their dan yang untuk dengan ini itu saya anda kita jika atau tidak akan dari pada ada juga bisa sudah belum agar karena seperti lalu dulu coba'.split(
		' '
	)
);

export function promptTokens(text: string): string[] {
	const words = text
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, ' ')
		.replace(/[^a-z0-9À-ɏ\s-]/g, ' ')
		.split(/\s+/)
		.filter((word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
	return [...new Set(words)].slice(0, 60);
}

export function similarity(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const setB = new Set(b);
	const shared = a.filter((word) => setB.has(word)).length;
	return shared / (new Set([...a, ...b]).size);
}

async function onOwnerPrompt(text: string, chatSessionId: string, projectId: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('[Clopen')) return;
	const tokens = promptTokens(trimmed.slice(0, 600));
	if (tokens.length < 4) return;
	const learned = load();
	const similar = learned.prompts.filter((prompt) => similarity(prompt.tokens, tokens) >= PROMPT_SIMILARITY);
	learned.prompts.push({ text: trimmed.slice(0, 600), tokens, sessionId: chatSessionId, projectId, at: Date.now() });
	if (learned.prompts.length > MAX_PROMPTS) learned.prompts = learned.prompts.slice(-MAX_PROMPTS);
	persist();

	const cluster = [...similar, { text: trimmed, tokens, sessionId: chatSessionId, projectId, at: Date.now() }];
	if (cluster.length < PROMPT_THRESHOLD || new Set(cluster.map((prompt) => prompt.sessionId)).size < 2) return;
	const key = [...tokens].sort().slice(0, 12).join(' ');
	if (learned.offeredPrompts.some((offered) => similarity(offered.split(' '), key.split(' ')) >= PROMPT_SIMILARITY)) return;
	learned.offeredPrompts = [...learned.offeredPrompts, key].slice(-100);
	persist();

	const examples = cluster.slice(-3).map((prompt, index) => `${index + 1}. ${prompt.text.slice(0, 500)}`).join('\n\n');
	const request = [
		'[Clopen · learning] The owner has asked for something similar several times. Here are the requests:',
		'',
		examples,
		'',
		'If this is a procedure worth keeping, write it as a skill with clopen skill.save: a clear name, a one-line description, and the steps — including the owner’s standing rules visible in these requests — with $ARGUMENTS where the request varies. If it is not worth a skill, say so in one line and stop.'
	].join('\n');

	if (getAssistantSettings().autonomy === 'autonomous') {
		try {
			await askAssistant(request, { title: 'Learning: a repeated request' });
		} catch (error) {
			debug.warn('assistant', 'Asking the assistant to write a skill failed:', error);
		}
		return;
	}
	raiseInboxItem({
		kind: 'suggestion',
		title: 'Turn a repeated request into a skill?',
		body: examples,
		data: { action: 'ask-assistant', prompt: request, title: 'Learning: a repeated request' },
		dedupe: `skill:${key}`
	});
}

/** Wire the learning loop to the stream. Called once at startup. */
export function initLearning(): void {
	streamManager.on('stream:message', (payload: { event: StreamEvent; chatSessionId: string; projectId?: string }) => {
		if (!payload.projectId) return;
		const message = (payload.event as { data?: { message?: any } }).data?.message;
		if (!message) return;
		if (message.type === 'user' && !message.synthetic && !message.parent?.toolUseId && Array.isArray(message.content)) {
			const project = projectQueries.getById(payload.projectId);
			if (!project || isAssistantProject(project)) return;
			const text = message.content
				.filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
				.map((block: any) => block.text as string)
				.join('\n');
			void onOwnerPrompt(text, payload.chatSessionId, payload.projectId).catch((error) => debug.warn('assistant', 'Learning from a prompt failed:', error));
			return;
		}
		if (message.type !== 'assistant' || !Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (block?.type !== 'tool_use' || typeof block.name !== 'string' || !SHELL_TOOLS.test(block.name)) continue;
			const command = typeof block.input?.command === 'string' ? block.input.command : typeof block.input?.cmd === 'string' ? block.input.cmd : null;
			if (command) onShellCommand(payload.chatSessionId, payload.projectId, command);
		}
	});
	streamManager.on('stream:lifecycle', (event: { chatSessionId?: string }) => {
		if (!event.chatSessionId) return;
		void onTurnCommandsSettled(event.chatSessionId).catch((error) => debug.warn('assistant', 'Learning from commands failed:', error));
	});
}

/** Record a command the control surface ran on an agent's behalf (`terminal.run`). */
export function noteControlCommand(chatSessionId: string | null, projectId: string, command: string): void {
	if (!chatSessionId) return;
	onShellCommand(chatSessionId, projectId, command);
}
