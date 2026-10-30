/**
 * Rendering the run report.
 *
 * The report is the agent's only view of what happened, so it leads with the
 * count that matters (`4/6`), lists every action with its own outcome, and
 * ends with where the browser was left. Images follow as their own blocks,
 * each labelled with the action that produced it.
 */

import type { RunReport } from './runner';

export function formatReport(report: RunReport): {
	content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
	isError?: boolean;
} {
	const ran = report.steps.length;
	const total = ran + report.skipped;
	const ok = report.steps.filter((s) => s.ok).length;

	const header = [`Executed ${ok}/${total} action(s)`];
	if (report.tabId) header.push(report.tabId);
	if (report.url) header.push(report.url);

	const lines: string[] = [header.join(' · ')];

	// Say it plainly: the agent asked for one thing and got a tab it never
	// requested, and the blank page is why a screenshot may look empty.
	if (report.openedTabId) {
		lines.push(`No tab was open, so ${report.openedTabId} was opened (about:blank) for this batch.`);
	}

	for (const step of report.steps) {
		const label = `[${step.index + 1}] ${step.type}`;
		lines.push(step.ok ? `${label} ok${step.summary ? ` → ${step.summary}` : ''}` : `${label} FAILED → ${step.error}`);
		if (step.detail) lines.push(indent(step.detail));
	}

	if (report.aborted) {
		lines.push('', 'Interrupted: the chat stream was cancelled, so the remaining actions did not run.');
	} else if (report.skipped > 0) {
		lines.push(
			'',
			report.dialog
				? `${report.skipped} action(s) skipped: the page is paused on the dialog below.`
				: `${report.skipped} action(s) skipped after the failure above (onError defaults to "stop").`
		);
	}

	if (report.dialog) {
		const { tabId, type, message, defaultValue } = report.dialog;
		const prompt = type === 'prompt' ? `, text:"…"` : '';
		lines.push(
			'',
			`DIALOG OPEN on ${tabId} — ${type}: ${JSON.stringify(message)}${type === 'prompt' && defaultValue ? ` (default ${JSON.stringify(defaultValue)})` : ''}`,
			`The page runs nothing until it is answered. Decide as the user would and reply with {type:"dialog", response:"accept"|"dismiss"${prompt}}.`
		);
	}

	if (report.agentTabs?.length) {
		const listed = report.agentTabs.map((tab) => `${tab.id} (${tab.url || 'blank'})`).join(', ');
		lines.push(
			'',
			`Tabs you opened that are still open: ${listed}. Close each with close_tab once you are done — keep one only if this chat will use it again, it is waiting on the user, or the user asked to keep it.`
		);
	}

	const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
		{ type: 'text', text: lines.join('\n') }
	];

	for (const image of report.images) {
		if (image.label) content.push({ type: 'text', text: `— ${image.label} —` });
		content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
	}

	return { content, isError: report.failed || report.aborted ? true : undefined };
}

/** Keep multi-line payloads visually attached to their action. */
function indent(text: string): string {
	return text
		.split('\n')
		.map((line) => `    ${line}`)
		.join('\n');
}
