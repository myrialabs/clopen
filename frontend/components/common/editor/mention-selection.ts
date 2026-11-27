/**
 * "Mention in Chat" on an editor's context menu: the selected lines go into
 * the open chat's message box as an `@N`, the way picking them from `@` would.
 * Unsaved edits included — it is what the user is looking at.
 */

import type { editor } from 'monaco-editor';
import { mentionCode } from '$frontend/services/chat/mentions';

export interface MentionInfo {
	path?: string;
	language?: string;
	/** For a buffer holding only some of a file's lines (a diff of hunks): its line → the file's. */
	lineNumbers?: number[];
}

export function addMentionAction(target: editor.IStandaloneCodeEditor, info: () => MentionInfo): { dispose(): void } {
	return target.addAction({
		id: 'clopen.mention-in-chat',
		label: 'Mention in Chat',
		contextMenuGroupId: '9_cutcopypaste',
		contextMenuOrder: 10,
		run: (ed) => {
			const model = ed.getModel();
			const selection = ed.getSelection();
			if (!model || !selection) return;
			// No selection: the line the cursor is on.
			const range = selection.isEmpty()
				? { startLineNumber: selection.startLineNumber, startColumn: 1, endLineNumber: selection.startLineNumber, endColumn: model.getLineMaxColumn(selection.startLineNumber) }
				: selection;
			// A selection ending at column 1 does not take that line.
			const endLine = range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range.endLineNumber;
			const { path, language, lineNumbers } = info();
			const fileLine = (line: number) => lineNumbers?.[line - 1] ?? line;
			mentionCode({
				path,
				language: language ?? model.getLanguageId(),
				text: model.getValueInRange(range),
				startLine: fileLine(range.startLineNumber),
				endLine: fileLine(endLine)
			});
		}
	});
}
