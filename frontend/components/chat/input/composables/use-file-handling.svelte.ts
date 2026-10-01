import { addNotification } from '$frontend/stores/ui/notification.svelte';
import { debug } from '$shared/utils/logger';

// ── File attachment type ──────────────────────────────────────
export type FileCategory = 'image' | 'pdf' | 'audio' | 'video';

export interface FileAttachment {
	id: string;
	file: File;
	type: FileCategory;
	base64?: string;
	previewUrl?: string;
}

// ── MIME types per input modality ─────────────────────────────
export const MIME_BY_MODALITY: Record<FileCategory, readonly string[]> = {
	image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
	pdf: ['application/pdf'],
	audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4'],
	video: ['video/mp4', 'video/webm', 'video/ogg'],
};

/** Build a flat list of allowed MIME types from model input modalities */
export function buildAcceptedMimeTypes(modalities: { image: boolean; pdf: boolean; audio: boolean; video: boolean }): string[] {
	const types: string[] = [];
	for (const key of Object.keys(MIME_BY_MODALITY) as FileCategory[]) {
		if (modalities[key]) types.push(...MIME_BY_MODALITY[key]);
	}
	return types;
}

/** Category of a MIME type; unknown types are treated as documents. */
export function categoryForMime(mimeType: string): FileCategory {
	for (const [category, mimes] of Object.entries(MIME_BY_MODALITY)) {
		if ((mimes as readonly string[]).includes(mimeType)) return category as FileCategory;
	}
	return mimeType.startsWith('image/') ? 'image' : 'pdf';
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
		const blob = new Blob([bytes], { type: source.mediaType });
		const type = categoryForMime(source.mediaType);
		return {
			id: source.id ?? crypto.randomUUID(),
			file: new File([blob], source.fileName, { type: source.mediaType }),
			type,
			base64: source.base64,
			previewUrl: type === 'image' ? URL.createObjectURL(blob) : undefined
		};
	} catch (error) {
		debug.error('chat', 'Error decoding attachment:', error);
		return null;
	}
}

// ── Constants ─────────────────────────────────────────────────
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALL_MIME_TYPES = Object.values(MIME_BY_MODALITY).flat();

// ── Composable ────────────────────────────────────────────────
export function useFileHandling() {
	let attachedFiles = $state<FileAttachment[]>([]);
	let isDragging = $state(false);
	// A count, not a flag: a paste landing while a drop is still being read
	// must not mark processing as finished when the first batch is.
	let processingCount = $state(0);

	/** Currently allowed MIME types — updated by ChatInput based on the active model */
	let allowedTypes = $state<string[]>(ALL_MIME_TYPES);

	async function fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const base64 = reader.result as string;
				const base64Data = base64.split(',')[1];
				resolve(base64Data);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	async function processFiles(files: FileList | File[]) {
		processingCount++;
		const fileArray = Array.from(files);

		for (const file of fileArray) {
			if (file.size > MAX_FILE_SIZE) {
				addNotification({
					type: 'error',
					title: 'File Too Large',
					message: `${file.name} exceeds the 10MB limit`,
					duration: 3000
				});
				continue;
			}

			if (!allowedTypes.includes(file.type)) {
				addNotification({
					type: 'error',
					title: 'Unsupported File Type',
					message: `${file.name} is not supported by the current model.`,
					duration: 4000
				});
				continue;
			}

			if (attachedFiles.some((f) => f.file.name === file.name && f.file.size === file.size)) {
				continue;
			}

			const category = categoryForMime(file.type);
			const attachment: FileAttachment = {
				id: crypto.randomUUID(),
				file,
				type: category
			};

			try {
				attachment.base64 = await fileToBase64(file);

				if (category === 'image') {
					attachment.previewUrl = URL.createObjectURL(file);
				}

				attachedFiles = [...attachedFiles, attachment];
			} catch (error) {
				debug.error('chat', 'Error processing file:', error);
				addNotification({
					type: 'error',
					title: 'File Processing Error',
					message: `Failed to process ${file.name}`,
					duration: 3000
				});
			}
		}

		processingCount--;
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

	async function handleFileInputChange(event: Event) {
		const input = event.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			await processFiles(input.files);
			input.value = '';
		}
	}

	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		isDragging = true;
	}

	function handleDragLeave(event: DragEvent) {
		event.preventDefault();
		// dragleave also fires when the pointer moves onto a child of the drop
		// zone; only leaving the zone itself ends the drag.
		const zone = event.currentTarget as Node | null;
		const next = event.relatedTarget as Node | null;
		if (zone && next && zone.contains(next)) return;
		isDragging = false;
	}

	async function handleDrop(event: DragEvent) {
		event.preventDefault();
		isDragging = false;

		if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
			await processFiles(event.dataTransfer.files);
		}
	}

	async function handlePaste(event: ClipboardEvent) {
		const items = event.clipboardData?.items;
		if (!items) return;

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
			await processFiles(files);
		}
	}

	return {
		get attachedFiles() { return attachedFiles; },
		get isDragging() { return isDragging; },
		get isProcessingFiles() { return processingCount > 0; },

		/** Set allowed MIME types (call when model changes) */
		set allowedTypes(types: string[]) { allowedTypes = types; },
		get allowedTypes() { return allowedTypes; },

		processFiles,
		removeAttachment,
		replaceAttachments,
		clearAllAttachments,
		handleFileSelect,
		handleFileInputChange,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handlePaste,
	};
}
