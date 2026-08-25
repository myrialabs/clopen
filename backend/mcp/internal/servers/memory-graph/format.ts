/**
 * Rendering the run report.
 *
 * The report is the agent's only view of the graph, so it leads with the count
 * that matters, keeps each operation's outcome separate, and says plainly when
 * the graph was queried without project context — otherwise an empty result
 * looks like "nothing was ever decided" when it actually means "you asked
 * outside any project".
 */

import type { RunReport } from './runner';

export function formatReport(report: RunReport): {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
} {
	const total = report.operations.length;
	const ok = report.operations.filter(o => o.ok).length;

	const lines: string[] = [`Memory Graph — ${ok}/${total} operation(s) succeeded`];

	if (!report.projectScoped) {
		lines.push('No project context for this call, so project-scoped memories were not searched.');
	}

	for (const [index, operation] of report.operations.entries()) {
		lines.push('', `[${index + 1}] ${operation.action}${operation.ok ? '' : ' FAILED'}`);
		lines.push(indent(operation.text));
	}

	return {
		content: [{ type: 'text', text: lines.join('\n') }],
		// Only a batch where nothing worked counts as an error: a partially useful
		// result is still useful, and flagging it would push the agent to retry work
		// that already landed.
		...(ok === 0 && total > 0 && { isError: true })
	};
}

function indent(text: string): string {
	return text
		.split('\n')
		.map(line => (line ? `  ${line}` : line))
		.join('\n');
}
