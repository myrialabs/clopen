/**
 * Which of a set of ids appear anywhere in a set of files.
 *
 * Streams each file once and searches every chunk for every id still unseen,
 * keeping the tail of the previous chunk so an id split across a chunk boundary
 * is still found. Stops reading as soon as every id has been found.
 */

import { readFileChunks, yieldToEventLoop } from '../fs-size';

export async function findReferencedIds(files: string[], ids: Iterable<string>): Promise<Set<string>> {
	const pending = new Set(ids);
	const found = new Set<string>();
	if (pending.size === 0) return found;
	const overlap = Math.max(...[...pending].map(id => id.length));
	const decoder = new TextDecoder();

	for (const file of files) {
		if (pending.size === 0) break;
		let tail = '';
		try {
			for await (const chunk of readFileChunks(file)) {
				const text = tail + decoder.decode(chunk, { stream: true });
				for (const id of pending) {
					if (text.includes(id)) {
						found.add(id);
						pending.delete(id);
					}
				}
				if (pending.size === 0) break;
				tail = text.slice(-overlap);
			}
		} catch {
			// An unreadable file cannot prove an id unused. Treat everything still
			// pending as referenced rather than delete what it might point at.
			for (const id of pending) found.add(id);
			pending.clear();
		}
		await yieldToEventLoop();
	}
	return found;
}
