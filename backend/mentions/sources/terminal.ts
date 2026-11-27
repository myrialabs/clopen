/**
 * A terminal tab's output.
 *
 * The tabs are listed by the composer, which knows their names; the output is
 * read here, from the scrollback PtyKit keeps for every session — so a tab
 * whose panel is closed can still be mentioned.
 */

import { ptyKitManager } from '$backend/terminal/ptykit';
import { scopeProjectId } from '$shared/utils/workspace-scope';
import { buildContextDocument, countLines } from '$shared/utils/context-document';
import { stripAnsi } from '../shared';
import { refOptional, refString, type MentionSource } from '../types';

/** The scrollback as plain lines, without the blank screen below the prompt. */
export function terminalText(serialized: string): string {
	const text = stripAnsi(serialized).replace(/\r\n?/g, '\n');
	return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

export const terminalSource: MentionSource = {
	kinds: ['terminal'],
	categories: () => [],
	list: async () => [],

	async capture(ctx, _kind, ref) {
		const sessionId = refString(ref, 'sessionId');
		const session = ptyKitManager.getSession(sessionId);
		if (!session || scopeProjectId(session.namespace) !== ctx.projectId) {
			throw new Error('That terminal is no longer open');
		}
		const name = refOptional(ref, 'name') ?? 'Terminal';
		const output = terminalText(ptyKitManager.getSerializedState(sessionId));
		return {
			documents: [
				buildContextDocument({
					kind: 'terminal',
					label: name,
					detail: countLines(output),
					facts: [
						['Working directory', session.cwd],
						['Status', session.status === 'exited' ? `exited (${session.exitCode ?? '?'})` : 'running'],
						['Size', `${session.cols}×${session.rows}`]
					],
					sections: [{ title: 'Output', body: output, fence: 'text' }]
				})
			]
		};
	}
};
