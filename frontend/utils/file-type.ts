/**
 * Shared file type detection utilities.
 * Used by FileViewer, DiffViewer, and MediaPreview.
 *
 * Extension lists are sourced from shared/constants/binary-extensions.ts
 * to stay in sync with the backend's file-type-detection.
 */

import {
	NON_PREVIEWABLE_BINARY_EXTENSIONS,
	IMAGE_EXTENSIONS,
	BROWSER_DEPENDENT_IMAGE_EXTENSIONS,
	AUDIO_EXTENSIONS,
	VIDEO_EXTENSIONS
} from '$shared/constants/binary-extensions';

function getExtension(fileName: string): string {
	return fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
}

/** An image a browser may display — HEIC and TIFF only in some (see MediaPreview's fallback). */
export function isImageFile(fileName: string): boolean {
	const extension = getExtension(fileName);
	return IMAGE_EXTENSIONS.has(extension) || BROWSER_DEPENDENT_IMAGE_EXTENSIONS.has(extension);
}

// Raster formats the image editor can both read and write back via sharp.
// Limited to formats browsers can decode in an <img> (the editor loads the
// source client-side). SVG (vector), ICO and BMP are excluded — sharp cannot
// encode them — and TIFF/HEIC are excluded because browsers can't decode them.
const EDITABLE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'];

/** Returns true if the file is a raster image the editor can edit and save. */
export function isEditableImageFile(fileName: string): boolean {
	return EDITABLE_IMAGE_EXTENSIONS.includes(getExtension(fileName));
}

export function isSvgFile(fileName: string): boolean {
	return fileName.toLowerCase().endsWith('.svg');
}

export function isPdfFile(fileName: string): boolean {
	return fileName.toLowerCase().endsWith('.pdf');
}

export function isAudioFile(fileName: string): boolean {
	return AUDIO_EXTENSIONS.has(getExtension(fileName));
}

export function isVideoFile(fileName: string): boolean {
	return VIDEO_EXTENSIONS.has(getExtension(fileName));
}

/** Non-previewable binary file detection, sourced from shared constants. */
export function isBinaryFile(fileName: string): boolean {
	return NON_PREVIEWABLE_BINARY_EXTENSIONS.has(getExtension(fileName));
}

export function isVisualFile(fileName: string): boolean {
	return isImageFile(fileName) || isSvgFile(fileName) || isPdfFile(fileName);
}

export function isMediaFile(fileName: string): boolean {
	return isAudioFile(fileName) || isVideoFile(fileName);
}

/** Returns true if the file can be rendered as a media preview (image, SVG, PDF, audio, video). */
export function isPreviewableFile(fileName: string): boolean {
	return isVisualFile(fileName) || isMediaFile(fileName);
}

/** Detects the backend's binary placeholder content pattern. */
export function isBinaryContent(content: string): boolean {
	return /^\[Binary file - \d+ bytes\]$/.test(content);
}


/**
 * MIME types by extension, for files whose type the browser leaves empty —
 * common on Android, and for anything the OS has no registered handler for.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif',
	'.webp': 'image/webp', '.avif': 'image/avif', '.apng': 'image/apng', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
	'.svg': 'image/svg+xml', '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
	'.pdf': 'application/pdf',
	'.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
	'.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.weba': 'audio/webm', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
	'.wma': 'audio/x-ms-wma',
	'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
	'.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
	'.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.m2ts': 'video/mp2t',
	'.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv',
	'.tsv': 'text/tab-separated-values', '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'application/yaml',
	'.yml': 'application/yaml', '.toml': 'application/toml', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
	'.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.sql': 'application/sql',
	'.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
	'.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

/** The MIME type a file name implies, or '' when the extension is unknown. */
export function mimeTypeFromName(fileName: string): string {
	return MIME_BY_EXTENSION[getExtension(fileName)] ?? '';
}

/** A file's MIME type, from the file name when the browser left it empty. */
export function effectiveMimeType(fileName: string, mediaType: string | null | undefined): string {
	if (mediaType && mediaType !== 'application/octet-stream') return mediaType;
	return mimeTypeFromName(fileName) || mediaType || 'application/octet-stream';
}

export type PreviewKind = 'image' | 'svg' | 'pdf' | 'audio' | 'video' | 'other';

/**
 * Which viewer a file opens in, by its name and — for names without a known
 * extension, like a pasted "image" — its MIME type.
 */
export function previewKind(fileName: string, mediaType?: string | null): PreviewKind {
	if (isSvgFile(fileName)) return 'svg';
	if (isPdfFile(fileName)) return 'pdf';
	if (isImageFile(fileName)) return 'image';
	if (isAudioFile(fileName)) return 'audio';
	if (isVideoFile(fileName)) return 'video';
	const type = mediaType ?? '';
	if (type === 'image/svg+xml') return 'svg';
	if (type === 'application/pdf') return 'pdf';
	if (type.startsWith('image/')) return 'image';
	if (type.startsWith('audio/')) return 'audio';
	if (type.startsWith('video/')) return 'video';
	return 'other';
}
