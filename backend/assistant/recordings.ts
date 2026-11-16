/**
 * Teach a task — record what the owner does in the Preview Browser once, and
 * turn it into a skill (or a script) that an agent can repeat.
 *
 * While a recording is running for a project, every viewer-originated input
 * the preview receives (navigations, clicks, typing, keys, scrolls) is
 * appended as a step. A click is stored with a description of the element
 * under the pointer — tag, id, label, text — resolved in the page at the
 * moment of the click, because coordinates alone do not survive a different
 * viewport or a reflowed page; the description is what lets an agent find the
 * same thing again.
 *
 * Turning a recording into a skill writes the steps as Browser Automation
 * actions plus a plain-language walkthrough, so the agent that runs the skill
 * can replay the steps or adapt them when the page has changed.
 */

import type { Page } from 'puppeteer';
import { taskRecordingQueries } from '$backend/database/queries';
import type { RecordedStep, Script, TaskRecording } from '$shared/types/assistant';
import { debug } from '$shared/utils/logger';
import { notifyAssistantChanged } from './events';
import { toRecording } from './mappers';
import { saveScript, slugify } from './scripts';
import { saveSkillContent } from './skills';

/** A recording longer than this stops growing — a task, not a session log. */
const MAX_STEPS = 400;

/** Active recording per project, cached so input handling never hits the database to find out there is none. */
const active = new Map<string, string>();
const loaded = new Set<string>();

function ensureLoaded(projectId: string): void {
	if (loaded.has(projectId)) return;
	loaded.add(projectId);
	try {
		const row = taskRecordingQueries.activeForProject(projectId);
		if (row) active.set(projectId, row.id);
	} catch {
		// The table may not exist yet during early startup; recording is simply off.
	}
}

export function isRecording(projectId: string): boolean {
	ensureLoaded(projectId);
	return active.has(projectId);
}

export function startRecording(projectId: string): TaskRecording {
	const existing = active.get(projectId);
	if (existing) {
		const row = taskRecordingQueries.getById(existing);
		if (row?.status === 'recording') return toRecording(row);
	}
	const row = taskRecordingQueries.create(projectId);
	active.set(projectId, row.id);
	notifyAssistantChanged('recordings', row.id);
	return toRecording(row);
}

export function stopRecording(projectId: string): TaskRecording | null {
	const id = active.get(projectId) ?? taskRecordingQueries.activeForProject(projectId)?.id;
	active.delete(projectId);
	if (!id) return null;
	taskRecordingQueries.setStatus(id, 'stopped');
	notifyAssistantChanged('recordings', id);
	const row = taskRecordingQueries.getById(id);
	return row ? toRecording(row) : null;
}

function append(projectId: string, step: RecordedStep): void {
	const id = active.get(projectId);
	if (!id) return;
	const row = taskRecordingQueries.getById(id);
	if (!row || row.status !== 'recording') {
		active.delete(projectId);
		return;
	}
	const steps = toRecording(row).steps;
	if (steps.length >= MAX_STEPS) return;
	const last = steps[steps.length - 1];
	// Consecutive typing into the same target is one step, not one per keystroke batch.
	if (step.type === 'type' && last?.type === 'type' && last.target === step.target) {
		last.text += step.text;
	} else if (step.type === 'scroll' && last?.type === 'scroll') {
		last.deltaY += step.deltaY;
	} else {
		steps.push(step);
	}
	taskRecordingQueries.setSteps(id, steps);
	notifyAssistantChanged('recordings', id);
}

/** Describe the element at a point, in terms an agent can find again. */
async function describeElementAt(page: Page, x: number, y: number): Promise<string | null> {
	try {
		return await Promise.race([
			page.evaluate(
				(px: number, py: number) => {
					const element = document.elementFromPoint(px, py) as HTMLElement | null;
					if (!element) return null;
					const target = (element.closest('a,button,input,select,textarea,[role="button"],[role="link"],label') as HTMLElement | null) ?? element;
					const parts: string[] = [target.tagName.toLowerCase()];
					if (target.id) parts.push(`#${target.id}`);
					const name = target.getAttribute('name');
					if (name) parts.push(`[name="${name}"]`);
					const label = target.getAttribute('aria-label') || target.getAttribute('placeholder') || target.getAttribute('title');
					const text = (target.innerText || (target as HTMLInputElement).value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
					return `${parts.join('')}${label ? ` (${label})` : ''}${text ? ` "${text}"` : ''}`;
				},
				x,
				y
			),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 400))
		]);
	} catch {
		return null;
	}
}

/** Called for every viewer input the preview handles. Never throws. */
export async function recordPreviewInput(
	projectId: string,
	page: Page | null | undefined,
	action: { type: string; x?: number; y?: number; text?: string; key?: string; deltaY?: number }
): Promise<void> {
	if (!isRecording(projectId)) return;
	try {
		const at = Date.now();
		switch (action.type) {
			case 'click':
			case 'doubleclick': {
				if (action.x === undefined || action.y === undefined) return;
				const target = page ? await describeElementAt(page, action.x, action.y) : null;
				append(projectId, { type: 'click', x: Math.round(action.x), y: Math.round(action.y), target, url: page?.url() ?? null, at });
				return;
			}
			case 'type':
			case 'paste':
				if (action.text) append(projectId, { type: 'type', text: action.text, target: null, at });
				return;
			case 'key':
				if (!action.key) return;
				// A printable key is typing; only named keys (Enter, Tab…) are steps of their own.
				if (action.key.length === 1) append(projectId, { type: 'type', text: action.key, target: null, at });
				else append(projectId, { type: 'key', key: action.key, at });
				return;
			case 'scroll':
				if (action.deltaY) append(projectId, { type: 'scroll', deltaY: Math.round(action.deltaY), at });
				return;
			default:
				return;
		}
	} catch (error) {
		debug.warn('assistant', 'Recording a preview input failed:', error);
	}
}

export function recordPreviewNavigation(projectId: string, url: string): void {
	if (!isRecording(projectId)) return;
	append(projectId, { type: 'navigate', url, at: Date.now() });
}

// ── Turning a recording into something reusable ────────────────────────────

function stepLine(step: RecordedStep, index: number): string {
	switch (step.type) {
		case 'navigate':
			return `${index}. Open ${step.url}`;
		case 'click':
			return `${index}. Click ${step.target ?? `the point (${step.x}, ${step.y})`}`;
		case 'type':
			return `${index}. Type "${step.text}"`;
		case 'key':
			return `${index}. Press ${step.key}`;
		case 'scroll':
			return `${index}. Scroll ${step.deltaY > 0 ? 'down' : 'up'} ${Math.abs(step.deltaY)}px`;
	}
}

function automationAction(step: RecordedStep): Record<string, unknown> {
	switch (step.type) {
		case 'navigate':
			return { action: 'navigate', url: step.url };
		case 'click':
			return { action: 'click', x: step.x, y: step.y, note: step.target ?? undefined };
		case 'type':
			return { action: 'type', text: step.text };
		case 'key':
			return { action: 'press', key: step.key };
		case 'scroll':
			return { action: 'scroll', deltaY: step.deltaY };
	}
}

export function recordingToMarkdown(recording: TaskRecording, name: string, purpose: string): string {
	const walkthrough = recording.steps.map((step, index) => stepLine(step, index + 1)).join('\n');
	const actions = JSON.stringify(recording.steps.map(automationAction), null, 2);
	return [
		`# ${name}`,
		'',
		purpose.trim() || 'A task recorded in the Preview Browser.',
		'',
		'## Steps (as recorded)',
		walkthrough || '(no steps)',
		'',
		'## How to run it',
		'Use the browser `browse` tool. Prefer finding each element by its description (text, label, id) over the recorded coordinates — the page may have changed since it was recorded. If a step no longer applies, adapt it and say what you changed.',
		'',
		'Recorded actions, in order:',
		'```json',
		actions,
		'```'
	].join('\n');
}

export async function saveRecordingAsSkill(recordingId: string, name: string, purpose: string): Promise<{ slug: string }> {
	const row = taskRecordingQueries.getById(recordingId);
	if (!row) throw new Error('That recording no longer exists.');
	const recording = toRecording(row);
	if (recording.steps.length === 0) throw new Error('That recording has no steps.');
	const slug = slugify(name);
	await saveSkillContent({
		slug,
		name,
		description: purpose.trim() || `Recorded task: ${name}`,
		body: recordingToMarkdown(recording, name, purpose),
		createdBy: 'user',
		note: 'Created from a Preview Browser recording'
	});
	taskRecordingQueries.setStatus(row.id, 'saved', name);
	notifyAssistantChanged('recordings', row.id);
	return { slug };
}

/**
 * A recording as a script: a Bun script that replays the navigations and
 * reports each URL's status — the deterministic part of a recorded task. The
 * interactive part (clicks, typing) needs a page and is the skill's job.
 */
export function saveRecordingAsScript(recordingId: string, name: string): Script {
	const row = taskRecordingQueries.getById(recordingId);
	if (!row) throw new Error('That recording no longer exists.');
	const recording = toRecording(row);
	const urls = recording.steps.filter((step): step is Extract<RecordedStep, { type: 'navigate' }> => step.type === 'navigate').map((step) => step.url);
	if (urls.length === 0) throw new Error('That recording opened no pages, so there is nothing a script can replay. Save it as a skill instead.');
	const content = [
		'// Replays the pages opened in a recorded task and reports each one.',
		`const urls = ${JSON.stringify(urls, null, 2)};`,
		'let failed = 0;',
		'for (const url of urls) {',
		'\ttry {',
		'\t\tconst response = await fetch(url, { redirect: "follow" });',
		'\t\tconsole.log(`${response.status} ${url}`);',
		'\t\tif (!response.ok) failed++;',
		'\t} catch (error) {',
		'\t\tconsole.log(`ERR ${url}: ${error instanceof Error ? error.message : error}`);',
		'\t\tfailed++;',
		'\t}',
		'}',
		'process.exit(failed ? 1 : 0);'
	].join('\n');
	const script = saveScript({ name, description: `Replays the pages of the recorded task "${name}"`, runtime: 'bun', content, projectId: row.project_id, source: 'recording' });
	taskRecordingQueries.setStatus(row.id, 'saved', name);
	notifyAssistantChanged('recordings', row.id);
	return script;
}

export function listRecordings(projectId: string): TaskRecording[] {
	return taskRecordingQueries.list(projectId).map(toRecording);
}

export function deleteRecording(id: string): void {
	const row = taskRecordingQueries.getById(id);
	if (!row) return;
	if (active.get(row.project_id) === id) active.delete(row.project_id);
	taskRecordingQueries.delete(id);
	notifyAssistantChanged('recordings', id);
}
