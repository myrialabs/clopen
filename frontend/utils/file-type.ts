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
	AUDIO_EXTENSIONS,
	VIDEO_EXTENSIONS
} from '$shared/constants/binary-extensions';

function getExtension(fileName: string): string {
	return fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
}

export function isImageFile(fileName: string): boolean {
	return IMAGE_EXTENSIONS.has(getExtension(fileName));
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

