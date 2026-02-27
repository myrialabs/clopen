import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
import { debug } from '$shared/utils/logger';

// File attachments interface
export interface FileAttachment {
	id: string;
	file: File;
	type: 'image' | 'document';
	base64?: string;
	previewUrl?: string;
}

// Maximum file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Supported file types - Images and PDF only
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const SUPPORTED_DOCUMENT_TYPES = ['application/pdf'];

export function useFileHandling() {
	let attachedFiles = $state<FileAttachment[]>([]);
	let isDragging = $state(false);
	let isProcessingFiles = $state(false);

	function getFileType(mimeType: string): 'image' | 'document' {
		if (SUPPORTED_IMAGE_TYPES.includes(mimeType)) return 'image';
		return 'document';
	}

	async function fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const base64 = reader.result as string;
				// Remove the data:type/subtype;base64, prefix
				const base64Data = base64.split(',')[1];
				resolve(base64Data);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	async function processFiles(files: FileList | File[]) {
		isProcessingFiles = true;
		const fileArray = Array.from(files);

		for (const file of fileArray) {
			// Check file size
			if (file.size > MAX_FILE_SIZE) {
				addNotification({
					type: 'error',
					title: 'File Too Large',
					message: `${file.name} exceeds the 10MB limit`,
					duration: 3000
				});
				continue;
			}

			// Check if file type is supported
			const isSupported = [...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_DOCUMENT_TYPES].includes(
				file.type
			);
			if (!isSupported) {
				addNotification({
					type: 'error',
					title: 'Unsupported File Type',
					message: `${file.name} is not supported. Only images (JPEG, PNG, GIF, WebP) and PDF documents are allowed.`,
					duration: 4000
				});
				continue;
			}

			// Check for duplicates
			if (attachedFiles.some((f) => f.file.name === file.name && f.file.size === file.size)) {
				continue;
			}

			const fileType = getFileType(file.type);
			const attachment: FileAttachment = {
				id: crypto.randomUUID(),
				file,
				type: fileType
			};

			// Convert to base64
			try {
				attachment.base64 = await fileToBase64(file);

				// Create preview URL for images
				if (fileType === 'image') {
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

		isProcessingFiles = false;
	}

	function removeAttachment(id: string) {
		const attachment = attachedFiles.find((f) => f.id === id);
		if (attachment?.previewUrl) {
			URL.revokeObjectURL(attachment.previewUrl);
		}
		attachedFiles = attachedFiles.filter((f) => f.id !== id);
	}

	function clearAllAttachments() {
		attachedFiles.forEach((attachment) => {
			if (attachment.previewUrl) {
				URL.revokeObjectURL(attachment.previewUrl);
			}
		});
		attachedFiles = [];
	}

	// File input handlers
	function handleFileSelect(fileInputElement: HTMLInputElement | undefined) {
		fileInputElement?.click();
	}

	async function handleFileInputChange(event: Event) {
		const input = event.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			await processFiles(input.files);
			// Reset input so same file can be selected again
			input.value = '';
		}
	}

	// Drag and drop handlers
	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		isDragging = true;
	}

	function handleDragLeave(event: DragEvent) {
		event.preventDefault();
		isDragging = false;
	}

	async function handleDrop(event: DragEvent) {
		event.preventDefault();
		isDragging = false;

		if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
			await processFiles(event.dataTransfer.files);
		}
	}

	// Paste handler for images and documents
	async function handlePaste(event: ClipboardEvent) {
		const items = event.clipboardData?.items;
		if (!items) return;

		const files: File[] = [];

		for (let i = 0; i < items.length; i++) {
			const item = items[i];

			// Check if the item is a file
			if (item.kind === 'file') {
				const file = item.getAsFile();
				if (file) {
					files.push(file);
				}
			}
		}

		// Process the pasted files if any
		if (files.length > 0) {
			event.preventDefault(); // Prevent default paste behavior for files
			await processFiles(files);
		}
		// If no files, let the default paste behavior handle text
	}

	return {
		// State
		get attachedFiles() {
			return attachedFiles;
		},
		set attachedFiles(value: FileAttachment[]) {
			attachedFiles = value;
		},
		get isDragging() {
			return isDragging;
		},
		get isProcessingFiles() {
			return isProcessingFiles;
		},
		// Methods
		processFiles,
		removeAttachment,
		clearAllAttachments,
		handleFileSelect,
		handleFileInputChange,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handlePaste,
		// Constants
		SUPPORTED_IMAGE_TYPES,
		SUPPORTED_DOCUMENT_TYPES
	};
}
