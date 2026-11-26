/**
 * Attachments — one rule for every way a file reaches a prompt.
 *
 * The web composer and the chat apps both hand the stream image and document
 * blocks. What an engine can READ natively depends on the model: images and
 * PDFs when its input modalities say so, nothing else. Everything else is
 * still worth sending — a CSV, a log, a zip, a screenshot for a text-only
 * model — so instead of refusing it, the file is written into the session's
 * working tree and the prompt names it, which every engine can act on with its
 * own file tools.
 *
 * Every attachment is numbered within its message (`@1`, `@2`, …) and the
 * engine prompt labels each one with its number — see `labelAttachments`.
 *
 * Files land in `.clopen/attachments/` under the session's working root. The
 * folder ignores itself (`.clopen/.gitignore` is `*`), so an attachment never
 * shows up in git or in a turn's snapshot as a change the agent made.
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, extname, basename, relative, isAbsolute } from 'path';
import type { EngineModel, EngineType, FileBlock, StreamRequest, UserContentBlock } from '$shared/types/unified';
import { getModelsByEngine, registerModels } from '$shared/constants/engines';
import { debug } from '$shared/utils/logger';
import { MAX_ATTACHMENT_BYTES, MAX_INLINE_ATTACHMENT_BYTES } from '$shared/constants/attachments';

/** Image types every vision model takes inline. */
export const NATIVE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export const PDF_TYPE = 'application/pdf';


export const ATTACHMENTS_DIR = join('.clopen', 'attachments');

type Modalities = EngineModel['modalities']['input'];

/** When the model is unknown, assume what the web composer assumes. */
const FALLBACK_MODALITIES: Modalities = { text: true, image: true, pdf: true, audio: false, video: false };

/** A model's input modalities — from the registry, filling it on first use. */
export async function inputModalities(engine: EngineType, modelId: string): Promise<Modalities> {
	let models = getModelsByEngine(engine);
	if (models.length === 0) {
		try {
			const { initializeEngine } = await import('$backend/engine');
			models = await (await initializeEngine(engine)).getAvailableModels();
			registerModels(engine, models);
		} catch (error) {
			debug.warn('chat', 'Could not load models to check attachment support:', error);
		}
	}
	return models.find((model) => model.engine.model.id === modelId)?.modalities.input ?? FALLBACK_MODALITIES;
}

/** Can this model read a file of `mediaType` inline? */
export function isNative(mediaType: string, modalities: Modalities): boolean {
	if ((NATIVE_IMAGE_TYPES as readonly string[]).includes(mediaType)) return modalities.image;
	if (mediaType === PDF_TYPE) return modalities.pdf;
	return false;
}

export function base64Size(data: string): number {
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
	'image/jpeg': '.jpg',
	'image/png': '.png',
	'image/gif': '.gif',
	'image/webp': '.webp',
	'application/pdf': '.pdf',
	'text/plain': '.txt',
	'audio/ogg': '.ogg',
	'audio/mpeg': '.mp3',
	'video/mp4': '.mp4'
};

/** A file name that is safe on every OS and keeps its extension. */
function safeName(name: string | null | undefined, mediaType: string): string {
	const base = basename(name?.trim() || 'attachment').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '-').slice(0, 120) || 'attachment';
	return extname(base) ? base : `${base}${EXTENSION_BY_TYPE[mediaType] ?? ''}`;
}

function stamp(date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Write one attachment under `root` and return its path relative to `root`. */
export function saveAttachment(root: string, input: { data: Uint8Array; mediaType: string; name?: string | null }): string {
	const dir = join(root, ATTACHMENTS_DIR);
	mkdirSync(dir, { recursive: true });
	const ignore = join(root, '.clopen', '.gitignore');
	if (!existsSync(ignore)) writeFileSync(ignore, '*\n');

	const name = safeName(input.name, input.mediaType);
	let file = `${stamp()}-${name}`;
	for (let n = 2; existsSync(join(dir, file)); n++) file = `${stamp()}-${n}-${name}`;
	writeFileSync(join(dir, file), input.data);
	return join(ATTACHMENTS_DIR, file);
}

/**
 * Keep what the model reads inline; save the rest under `root` and keep a
 * `file` block saying where it went. Every attachment is numbered in the
 * order it was attached — the `@N` the user writes about it.
 */
export async function normalizeAttachments(request: StreamRequest, root: string): Promise<StreamRequest> {
	const content = (request.prompt as { content?: unknown })?.content;
	if (!Array.isArray(content)) return request;
	if (!content.some(isAttachment)) return request;

	const modalities = await inputModalities(request.engine.type, request.engine.model.id);
	const normalized: unknown[] = [];
	let index = 0;
	for (const block of content) {
		if (!isAttachment(block)) {
			normalized.push(block);
			continue;
		}
		index++;
		if (block.type === 'file') {
			normalized.push({ ...block, index });
			continue;
		}
		if (typeof block.data !== 'string') {
			normalized.push({ ...block, index });
			continue;
		}
		const mediaType = typeof block.mediaType === 'string' && block.mediaType ? block.mediaType : 'application/octet-stream';
		const title = typeof block.title === 'string' && block.title.trim() ? block.title.trim() : null;
		const size = base64Size(block.data);
		if (isNative(mediaType, modalities) && size <= MAX_INLINE_ATTACHMENT_BYTES) {
			normalized.push({ ...block, index });
			continue;
		}
		if (size > MAX_ATTACHMENT_BYTES) {
			normalized.push({ type: 'text', text: `[Attachment @${index} "${title ?? 'attachment'}" (${formatBytes(size)}) was too large to keep. The limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.]` });
			continue;
		}
		try {
			const path = saveAttachment(root, { data: Buffer.from(block.data, 'base64'), mediaType, name: title });
			normalized.push({ type: 'file', mediaType, title, size, path: join(root, path), index } satisfies FileBlock);
		} catch (error) {
			debug.warn('chat', 'Saving an attachment failed:', error);
			normalized.push({ type: 'text', text: `[Attachment @${index} "${title ?? 'attachment'}" could not be saved.]` });
		}
	}
	return { ...request, prompt: { ...request.prompt, content: normalized } as StreamRequest['prompt'] };
}

type AttachmentLike = { type: 'image' | 'document' | 'file'; data?: unknown; mediaType?: unknown; title?: unknown };

function isAttachment(block: unknown): block is AttachmentLike {
	const type = (block as { type?: unknown } | null)?.type;
	return type === 'image' || type === 'document' || type === 'file';
}

/** How the prompt names a file: its number, name, type and size. */
export function attachmentLabel(input: { index: number; title?: string | null; mediaType: string; size: number }): string {
	const name = input.title?.trim() ? `"${input.title.trim()}"` : 'a file';
	return `Attachment @${input.index}: ${name} (${input.mediaType || 'unknown type'}, ${formatBytes(input.size)})`;
}

/** A path as the engine, working in `root`, would write it. */
function displayPath(path: string, root: string): string {
	const inside = relative(root, path);
	if (!inside || inside.startsWith('..') || isAbsolute(inside)) return path;
	return `./${inside.split('\\').join('/')}`;
}

/**
 * What the engine is given for a user message. Every numbered attachment is
 * preceded by its label, and a saved file becomes a label saying where it is —
 * so `@3` in the text points at the same file for the model as for the user.
 * Engines that pull images out of the content keep the labels in the text, in
 * the same order. The saved message is left as it is: labels are for the
 * model, the timeline draws its own numbers.
 */
export function labelAttachments(content: UserContentBlock[], root: string): UserContentBlock[] {
	const labelled = content.some((block) => block.type === 'file' || ((block.type === 'image' || block.type === 'document') && block.index));
	if (!labelled) return content;

	const result: UserContentBlock[] = [];
	for (const block of content) {
		if (block.type === 'file') {
			const label = attachmentLabel({ index: block.index ?? 0, title: block.title, mediaType: block.mediaType, size: block.size });
			result.push({ type: 'text', text: `[${label}, saved at ${displayPath(block.path, root)}]` });
		} else if ((block.type === 'image' || block.type === 'document') && block.index) {
			const label = attachmentLabel({ index: block.index, title: block.title, mediaType: block.mediaType, size: base64Size(block.data) });
			result.push({ type: 'text', text: `[${label}]` }, block);
		} else {
			result.push(block);
		}
	}
	return result;
}
