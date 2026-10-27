/**
 * Files in a chat — both ways.
 *
 * IN: whatever a chat sends (a photo, an album, a PDF, a voice note, any
 * file) becomes the same image/document blocks the web composer produces.
 * What happens to them next is not decided here: the stream's one attachment
 * rule (`backend/chat/attachments.ts`) keeps what the model reads inline and
 * saves the rest into the session's folder, exactly as for the web.
 *
 * OUT: images an answer shows (`![alt](src)` or `<img src>`) are sent as
 * photos after its text, so a chart or a screenshot arrives as a picture
 * instead of a path. Local images are only read from the session's own
 * folder (or the system temp folder agents write screenshots to) — an answer
 * cannot be used to pull an arbitrary file off the machine.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { basename, extname, isAbsolute, resolve } from 'path';
import type { MessageContent, UniversalMessage } from '@myrialabs/chatkit';
import { isPathInside } from '$backend/worktrees';
import { formatBytes } from '$backend/chat/attachments';
import { MAX_ATTACHMENT_BYTES } from '$shared/constants/attachments';
import { debug } from '$shared/utils/logger';
import { channelRuntime, type ActiveChannel } from './runtime';
import type { ChannelFile } from './platforms';

/** A file from a chat, shaped like a web composer attachment. */
export interface PromptAttachment {
	type: 'image' | 'document';
	mediaType: string;
	/** base64 */
	data: string;
	title: string;
}

type MediaContent = Extract<MessageContent, { type: 'media' }>;

/** What a platform's own media kinds are when it does not say. */
const DEFAULT_MIME: Record<string, string> = {
	image: 'image/jpeg',
	sticker: 'image/webp',
	video: 'video/mp4',
	audio: 'audio/mpeg',
	voice: 'audio/ogg',
	document: 'application/octet-stream'
};

const DEFAULT_NAME: Record<string, string> = {
	image: 'photo.jpg',
	sticker: 'sticker.webp',
	video: 'video.mp4',
	audio: 'audio.mp3',
	voice: 'voice-note.ogg',
	document: 'file'
};

/** At most this many images go out with one answer. */
const MAX_ANSWER_IMAGES = 10;

/** How long fetching a remote image may take before it is skipped. */
const FETCH_TIMEOUT_MS = 15_000;

const IMAGE_EXTENSIONS: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.svg': 'image/svg+xml'
};

export function isMedia(content: MessageContent): content is MediaContent {
	return content.type === 'media';
}

/**
 * Read every file of `messages` out of ChatKit and into prompt blocks. A file
 * that never arrived (too big for the platform to hand a bot, a failed
 * download) is reported, not silently dropped.
 */
export async function collectAttachments(
	channel: ActiveChannel,
	messages: UniversalMessage[]
): Promise<{ attachments: PromptAttachment[]; problems: string[] }> {
	const attachments: PromptAttachment[] = [];
	const problems: string[] = [];
	for (const message of messages) {
		if (!isMedia(message.content)) continue;
		const content = message.content;
		const name = content.filename || DEFAULT_NAME[content.media_type] || 'file';
		const file = await channelRuntime.takeMedia(content.url);
		if (!file) {
			const size = content.size_bytes ?? 0;
			problems.push(
				size > channel.platform.maxInboundFileBytes
					? `${name} is ${formatBytes(size)}, and a bot can only receive files up to ${formatBytes(channel.platform.maxInboundFileBytes)}.`
					: `${name} could not be downloaded.`
			);
			continue;
		}
		if (file.data.byteLength > MAX_ATTACHMENT_BYTES) {
			problems.push(`${name} is ${formatBytes(file.data.byteLength)}, over the limit of ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
			continue;
		}
		const mediaType = content.mime || file.mime || DEFAULT_MIME[content.media_type] || 'application/octet-stream';
		attachments.push({
			type: mediaType.startsWith('image/') ? 'image' : 'document',
			mediaType,
			data: Buffer.from(file.data).toString('base64'),
			title: file.filename || name
		});
	}
	return { attachments, problems };
}

/** The text a chat message carries: its text, or a file's caption. */
export function textOf(content: MessageContent): string {
	if (content.type === 'text') return content.text;
	if (content.type === 'media') return content.caption ?? '';
	if (content.type === 'location') return `📍 Location: ${content.lat}, ${content.lng}${content.name ? ` (${content.name})` : ''}`;
	if (content.type === 'contact') return `👤 Contact: ${content.name} ${content.phone}`.trim();
	return '';
}

/** Prompt content in the web composer's order: files first, then the text. */
export function promptContent(text: string, attachments: PromptAttachment[]): unknown[] {
	const blocks: unknown[] = attachments.map((file) => ({ type: file.type, mediaType: file.mediaType, data: file.data, title: file.title }));
	if (text.trim() || blocks.length === 0) blocks.push({ type: 'text', text });
	return blocks;
}

// ── Images in an answer ─────────────────────────────────────────────────────

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*?(?:\balt\s*=\s*["']([^"']*)["'])?[^>]*>/gi;

interface ImageRef {
	match: string;
	alt: string;
	src: string;
}

function imageRefs(markdown: string): ImageRef[] {
	const refs: ImageRef[] = [];
	for (const match of markdown.matchAll(MARKDOWN_IMAGE)) refs.push({ match: match[0], alt: match[1], src: match[2] });
	for (const match of markdown.matchAll(HTML_IMAGE)) refs.push({ match: match[0], alt: match[2] ?? '', src: match[1] });
	return refs;
}

async function fetchImage(url: string): Promise<{ data: Uint8Array; mime: string } | null> {
	const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!response.ok) return null;
	const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim();
	if (!mime.startsWith('image/')) return null;
	const length = Number(response.headers.get('content-length') ?? 0);
	if (length > MAX_ATTACHMENT_BYTES) return null;
	const data = new Uint8Array(await response.arrayBuffer());
	return data.byteLength > MAX_ATTACHMENT_BYTES ? null : { data, mime };
}

function readLocalImage(src: string, root: string): { data: Uint8Array; mime: string; name: string } | null {
	let path = src;
	try {
		if (src.startsWith('file://')) path = decodeURIComponent(new URL(src).pathname);
		else path = decodeURIComponent(src);
	} catch {
		// Not URI-encoded: use it as written.
	}
	const full = isAbsolute(path) ? resolve(path) : resolve(root, path);
	if (!isPathInside(root, full) && !isPathInside(tmpdir(), full)) return null;
	const mime = IMAGE_EXTENSIONS[extname(full).toLowerCase()];
	if (!mime || !existsSync(full)) return null;
	const stats = statSync(full);
	if (!stats.isFile() || stats.size > MAX_ATTACHMENT_BYTES) return null;
	return { data: readFileSync(full), mime, name: basename(full) };
}

function decodeDataUri(src: string): { data: Uint8Array; mime: string } | null {
	const match = /^data:(image\/[\w.+-]+);base64,(.+)$/i.exec(src);
	return match ? { data: Buffer.from(match[2], 'base64'), mime: match[1].toLowerCase() } : null;
}

/**
 * The images `markdown` shows, as files to send, and the markdown with each
 * one that was found replaced by a short marker — the picture follows, so the
 * path would only be noise. Images that cannot be had are left as written.
 */
export async function answerImages(markdown: string, root: string | null): Promise<{ markdown: string; images: ChannelFile[] }> {
	const images: ChannelFile[] = [];
	let text = markdown;
	for (const ref of imageRefs(markdown).slice(0, MAX_ANSWER_IMAGES)) {
		try {
			let found: { data: Uint8Array; mime: string; name?: string } | null = null;
			if (/^data:/i.test(ref.src)) found = decodeDataUri(ref.src);
			else if (/^https?:\/\//i.test(ref.src)) found = await fetchImage(ref.src);
			else if (root) found = readLocalImage(ref.src, root);
			if (!found) continue;
			const filename = found.name ?? (basename(ref.src.split('?')[0]) || 'image');
			images.push({ data: found.data, mime: found.mime, filename, caption: ref.alt.trim() || undefined });
			text = text.replace(ref.match, `🖼️ ${ref.alt.trim() || filename}`);
		} catch (error) {
			debug.log('chat-apps', 'An image in an answer could not be sent:', error);
		}
	}
	return { markdown: text, images };
}
