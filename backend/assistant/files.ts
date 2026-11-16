/**
 * Files Clopen hands the owner — a screenshot, a generated image, a report.
 *
 * Whatever folder an agent wrote it to, the file is copied into Clopen's own
 * data folder under a random id, so the link the owner gets keeps working
 * after the agent cleans up, and nothing outside that folder is ever served.
 * The web UI fetches it from `/api/assistant/files/:id` (signed-in only); chat
 * apps get the bytes directly.
 */

import { copyFileSync, writeFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getClopenDir } from '$backend/utils/paths';

export interface SharedFile {
	id: string;
	filename: string;
	mime: string;
	size: number;
	url: string;
}

const MIME: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.pdf': 'application/pdf',
	'.txt': 'text/plain',
	'.md': 'text/markdown',
	'.csv': 'text/csv',
	'.json': 'application/json',
	'.html': 'text/html',
	'.zip': 'application/zip',
	'.mp4': 'video/mp4',
	'.mp3': 'audio/mpeg',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function mimeOf(path: string): string {
	return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function folder(): string {
	const dir = join(getClopenDir(), 'assistant', 'files');
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Copy a file the owner should receive; returns how to reach it. */
export function shareFile(path: string): SharedFile {
	const absolute = isAbsolute(path) ? path : resolve(homedir(), path.replace(/^~\//, ''));
	if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`There is no file at ${path}.`);
	const size = statSync(absolute).size;
	if (size > MAX_FILE_BYTES) throw new Error(`${basename(absolute)} is larger than 50 MB.`);
	const filename = basename(absolute).replace(/[^\w.\- ]+/g, '_');
	const id = `${crypto.randomUUID()}${extname(filename).toLowerCase()}`;
	copyFileSync(absolute, join(folder(), id));
	return { id, filename, mime: mimeOf(filename), size, url: `/api/assistant/files/${id}` };
}

/** Keep bytes the owner sent (a photo from Telegram, an attachment on the web) the same way, without a file first. */
export function shareBytes(data: Uint8Array, name: string, mime?: string): SharedFile {
	const filename = (name || 'file').replace(/[^\w.\- ]+/g, '_');
	const id = `${crypto.randomUUID()}${extname(filename).toLowerCase()}`;
	writeFileSync(join(folder(), id), data);
	return { id, filename, mime: mime || mimeOf(filename), size: data.byteLength, url: `/api/assistant/files/${id}` };
}

/** The stored copy for an id, or null (ids are uuid + extension only — no paths). */
export function sharedFilePath(id: string): string | null {
	if (!/^[0-9a-f-]{36}(\.[a-z0-9]{1,6})?$/i.test(id)) return null;
	const path = join(folder(), id);
	return existsSync(path) ? path : null;
}

export function readShared(file: SharedFile): { data: Uint8Array; mime: string; filename: string } {
	const path = sharedFilePath(file.id);
	if (!path) throw new Error('That file is gone.');
	return { data: new Uint8Array(readFileSync(path)), mime: file.mime, filename: file.filename };
}
