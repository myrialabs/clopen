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
 * Files land in `.clopen/attachments/` under the session's working root. The
 * folder ignores itself (`.clopen/.gitignore` is `*`), so an attachment never
 * shows up in git or in a turn's snapshot as a change the agent made.
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import type { EngineModel, EngineType, StreamRequest } from '$shared/types/unified';
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

/** The line a prompt carries for a file it does not hold inline. */
export function attachmentMention(relativePath: string, input: { mediaType: string; size: number; name?: string | null }): string {
	const label = input.name?.trim() ? `"${input.name.trim()}"` : 'a file';
	return `[Attached ${label} (${input.mediaType || 'unknown type'}, ${formatBytes(input.size)}), saved at ./${relativePath.split('\\').join('/')}]`;
}

/**
 * Keep what the model reads inline; save the rest under `root` and name it in
 * the prompt instead. Returns the request unchanged when nothing had to move.
 */
export async function normalizeAttachments(request: StreamRequest, root: string): Promise<StreamRequest> {
	const content = (request.prompt as { content?: unknown })?.content;
	if (!Array.isArray(content)) return request;
	const files = content.filter((block) => block?.type === 'image' || block?.type === 'document');
	if (files.length === 0) return request;

	const modalities = await inputModalities(request.engine.type, request.engine.model.id);
	const mentions: string[] = [];
	const kept: unknown[] = [];
	for (const block of content) {
		if ((block?.type !== 'image' && block?.type !== 'document') || typeof block.data !== 'string') {
			kept.push(block);
			continue;
		}
		const mediaType = typeof block.mediaType === 'string' ? block.mediaType : 'application/octet-stream';
		const size = base64Size(block.data);
		if (isNative(mediaType, modalities) && size <= MAX_INLINE_ATTACHMENT_BYTES) {
			kept.push(block);
			continue;
		}
		if (size > MAX_ATTACHMENT_BYTES) {
			mentions.push(`[An attached file "${block.title ?? 'attachment'}" (${formatBytes(size)}) was too large to keep. The limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.]`);
			continue;
		}
		try {
			const path = saveAttachment(root, { data: Buffer.from(block.data, 'base64'), mediaType, name: block.title });
			mentions.push(attachmentMention(path, { mediaType, size, name: block.title }));
		} catch (error) {
			debug.warn('chat', 'Saving an attachment failed:', error);
			mentions.push(`[An attached file "${block.title ?? 'attachment'}" could not be saved.]`);
		}
	}
	if (mentions.length === 0) return request;

	// The mention leads the text, so "summarise this" still reads as being about the file.
	const textIndex = kept.findIndex((block) => (block as { type?: string })?.type === 'text');
	const note = mentions.join('\n');
	if (textIndex === -1) kept.push({ type: 'text', text: note });
	else {
		const text = kept[textIndex] as { type: 'text'; text: string };
		kept[textIndex] = { type: 'text', text: text.text.trim() ? `${note}\n\n${text.text}` : note };
	}
	return { ...request, prompt: { ...request.prompt, content: kept } as StreamRequest['prompt'] };
}
