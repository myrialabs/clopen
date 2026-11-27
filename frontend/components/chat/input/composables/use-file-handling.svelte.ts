import { addNotification } from '$frontend/stores/ui/notification.svelte';
import { debug } from '$shared/utils/logger';
import { MAX_ATTACHMENT_BYTES } from '$shared/constants/attachments';
import { effectiveMimeType } from '$frontend/utils/file-type';
import { readContextHeaderFromBase64 } from '$shared/utils/context-document';
import type { ContextSource } from '$shared/types/mentions';

// ── File attachment type ──────────────────────────────────────
/** `file` is anything the model does not read inline — it is saved and named in the prompt. */
export type FileCategory = 'image' | 'pdf' | 'audio' | 'video' | 'file';

export interface FileAttachment {
	id: string;
	file: File;
	type: FileCategory;
	base64?: string;
	previewUrl?: string;
	/** What an `@` mention attached, read from the document's own header. */
	context?: ContextSource;
}

// ── MIME types per input modality ─────────────────────────────
export const MIME_BY_MODALITY: Record<Exclude<FileCategory, 'file'>, readonly string[]> = {
	image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
	pdf: ['application/pdf'],
	audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4'],
	video: ['video/mp4', 'video/webm', 'video/ogg'],
};

/** Category of a MIME type; anything unknown is a plain file. */
export function categoryForMime(mimeType: string): FileCategory {
	for (const [category, mimes] of Object.entries(MIME_BY_MODALITY)) {
		if ((mimes as readonly string[]).includes(mimeType)) return category as FileCategory;
	}
	return mimeType.startsWith('image/') ? 'image' : 'file';
}

/**
 * Rebuild an attachment from stored base64 (a restored draft, a message being
 * edited, a queued message taken back). The single place that decodes one.
 */
export function attachmentFromBase64(source: {
	id?: string;
	fileName: string;
	mediaType: string;
	base64: string;
}): FileAttachment | null {
	try {
		const byteString = atob(source.base64);
		const bytes = new Uint8Array(byteString.length);
		for (let i = 0; i < byteString.length; i++) {
			bytes[i] = byteString.charCodeAt(i);
		}
		const mediaType = effectiveMimeType(source.fileName, source.mediaType);
		const blob = new Blob([bytes], { type: mediaType });
		const type = categoryForMime(mediaType);
		const context = readContextHeaderFromBase64(source.base64, mediaType) ?? undefined;
		return {
			id: source.id ?? crypto.randomUUID(),
			file: new File([blob], source.fileName, { type: mediaType }),
			type,
			base64: source.base64,
			previewUrl: type === 'image' ? URL.createObjectURL(blob) : undefined,
			...(context && { context })
		};
	} catch (error) {
		debug.error('chat', 'Error decoding attachment:', error);
		return null;
	}
}

// ── Constants ─────────────────────────────────────────────────
const MAX_FILE_SIZE = MAX_ATTACHMENT_BYTES;

/**
 * The file with a usable MIME type. Browsers leave it empty for many files
 * (most on Android), which made a PDF a generic "file" with no preview.
 */
function withMimeType(file: File): File {
	const mediaType = effectiveMimeType(file.name, file.type);
	if (mediaType === file.type) return file;
	return new File([file], file.name, { type: mediaType, lastModified: file.lastModified });
}

// ── Composable ────────────────────────────────────────────────
export function useFileHandling() {
	let attachedFiles = $state<FileAttachment[]>([]);
	// Files still being read, so the list can hold their place. A count, not
	// a flag: a paste landing while a drop is still being read must not mark
	// processing as finished when the first batch is.
	let pendingCount = $state(0);

	async function fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const base64 = reader.result as string;
				const base64Data = base64.split(',')[1] ?? '';
				resolve(base64Data);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	/** Read files in; resolves with the attachments that were added, in order. */
	async function processFiles(files: FileList | File[]): Promise<FileAttachment[]> {
		const added: FileAttachment[] = [];
		const fileArray = Array.from(files);
		pendingCount += fileArray.length;
		const tooLarge: string[] = [];
		const duplicates: string[] = [];

		try {
			for (const original of fileArray) {
				try {
					if (original.size > MAX_FILE_SIZE) {
						tooLarge.push(original.name);
						continue;
					}

					const file = withMimeType(original);
					if (attachedFiles.some((f) => f.file.name === file.name && f.file.size === file.size)) {
						duplicates.push(file.name);
						continue;
					}

					const category = categoryForMime(file.type);
					const base64 = await fileToBase64(file);
					// A snapshot dropped back in (saved from an earlier message) is still one.
					const context = readContextHeaderFromBase64(base64, file.type) ?? undefined;
					const attachment: FileAttachment = {
						id: crypto.randomUUID(),
						file,
						type: category,
						base64,
						previewUrl: category === 'image' ? URL.createObjectURL(file) : undefined,
						...(context && { context })
					};
					attachedFiles = [...attachedFiles, attachment];
					added.push(attachment);
				} catch (error) {
					debug.error('chat', 'Error processing file:', error);
					addNotification({
						type: 'error',
						title: 'File Processing Error',
						message: `Failed to process ${original.name}`,
						duration: 3000
					});
				} finally {
					pendingCount--;
				}
			}
		} finally {
			if (tooLarge.length > 0) {
				addNotification({
					type: 'error',
					title: tooLarge.length === 1 ? 'File Too Large' : 'Files Too Large',
					message: `${listNames(tooLarge)} ${tooLarge.length === 1 ? 'exceeds' : 'exceed'} the ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`,
					duration: 4000
				});
			}
			if (duplicates.length > 0) {
				addNotification({
					type: 'info',
					title: 'Already Attached',
					message: `${listNames(duplicates)} ${duplicates.length === 1 ? 'is' : 'are'} already attached`,
					duration: 3000
				});
			}
		}
		return added;
	}

	function listNames(names: string[]): string {
		if (names.length <= 2) return names.join(' and ');
		return `${names[0]} and ${names.length - 1} more`;
	}

	function removeAttachment(id: string) {
		const attachment = attachedFiles.find((f) => f.id === id);
		if (attachment?.previewUrl) {
			URL.revokeObjectURL(attachment.previewUrl);
		}
		attachedFiles = attachedFiles.filter((f) => f.id !== id);
	}

	/** Swap in a new set, releasing the previews of the ones that go away. */
	function replaceAttachments(next: FileAttachment[]) {
		const kept = new Set(next.map((attachment) => attachment.previewUrl).filter(Boolean));
		for (const attachment of attachedFiles) {
			if (attachment.previewUrl && !kept.has(attachment.previewUrl)) {
				URL.revokeObjectURL(attachment.previewUrl);
			}
		}
		attachedFiles = next;
	}

	function clearAllAttachments() {
		replaceAttachments([]);
	}

	function handleFileSelect(fileInputElement: HTMLInputElement | undefined) {
		fileInputElement?.click();
	}

	async function handleFileInputChange(event: Event): Promise<FileAttachment[]> {
		const input = event.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			const files = Array.from(input.files);
			input.value = '';
			return processFiles(files);
		}
		return [];
	}

	async function handlePaste(event: ClipboardEvent): Promise<FileAttachment[]> {
		const items = event.clipboardData?.items;
		if (!items) return [];

		const files: File[] = [];

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.kind === 'file') {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}

		if (files.length > 0) {
			event.preventDefault();
			return processFiles(files);
		}
		return [];
	}

	/**
	 * Hold a place for attachments still on their way — a mention being
	 * captured. Returns the release; call it once, whatever the outcome.
	 */
	function holdPlace(): () => void {
		pendingCount++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			pendingCount--;
		};
	}

	return {
		get attachedFiles() { return attachedFiles; },
		get isProcessingFiles() { return pendingCount > 0; },
		/** Files still being read. */
		get pendingCount() { return pendingCount; },

		holdPlace,
		processFiles,
		removeAttachment,
		replaceAttachments,
		clearAllAttachments,
		handleFileSelect,
		handleFileInputChange,
		handlePaste,
	};
}
