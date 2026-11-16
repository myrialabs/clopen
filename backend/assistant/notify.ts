/**
 * Telling the owner something — with files when there are any.
 *
 * One message per event, to where the owner is: linked chat apps get the text
 * and the files themselves (the chat waiting on `fromSessionId`'s turn when
 * there is one, so a reply lands in its own conversation); the web UI gets an
 * update in Clopen's "Updates" with the files viewable; a push notification
 * goes out for anything not answered in a live conversation.
 */

import { debug } from '$shared/utils/logger';
import { raiseInboxItem, resolveInboxItem } from './inbox';
import { readShared, shareFile, type SharedFile } from './files';
import type { CardRefs } from './cards';

export interface Told {
	itemId: string;
	files: SharedFile[];
	skipped: string[];
}

function firstLine(text: string): string {
	const line = text.trim().split('\n')[0].replace(/[*_#`]/g, '').trim();
	return line.length > 90 ? `${line.slice(0, 89)}…` : line || 'Update';
}

export async function tellOwner(input: { text: string; files?: string[]; title?: string; refs?: CardRefs; settled?: boolean }): Promise<Told> {
	const files: SharedFile[] = [];
	const skipped: string[] = [];
	for (const path of input.files ?? []) {
		try {
			files.push(shareFile(path));
		} catch (error) {
			skipped.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const item = raiseInboxItem({
		kind: 'report',
		title: input.title ?? firstLine(input.text),
		body: input.text,
		data: files.length ? { files } : {},
		skipChats: true,
		...input.refs
	});
	// Said is done: a report is not left waiting to be read (only "isn't working" ones stay open, raised elsewhere).
	if (input.settled !== false) resolveInboxItem(item.id, 'resolved', { by: 'clopen', note: 'Delivered' });
	try {
		const { sendFilesToChats } = await import('$backend/chat-apps');
		const result = await sendFilesToChats(
			files.map((file) => readShared(file)),
			{ fromSessionId: input.refs?.sessionId ?? null, text: input.text, chatId: (await import('./timeline')).chatOfItem(item) }
		);
		for (const failure of result.failed) skipped.push(`chat: ${failure}`);
	} catch (error) {
		debug.warn('assistant', 'Sending an update to chats failed:', error);
	}
	return { itemId: item.id, files, skipped };
}
