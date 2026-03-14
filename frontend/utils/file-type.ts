/**
 * Shared file type detection utilities.
 * Used by FileViewer, DiffViewer, and MediaPreview.
 *
 * Extension lists are sourced from shared/constants/binary-extensions.ts
 * to stay in sync with the backend's file-type-detection.
 */

import { NON_PREVIEWABLE_BINARY_EXTENSIONS } from '$shared/constants/binary-extensions';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.opus'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogv', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v'];

function getExtension(fileName: string): string {
	return fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
}

export function isImageFile(fileName: string): boolean {
	return IMAGE_EXTENSIONS.includes(getExtension(fileName));
}

export function isSvgFile(fileName: string): boolean {
	return fileName.toLowerCase().endsWith('.svg');
}

export function isPdfFile(fileName: string): boolean {
	return fileName.toLowerCase().endsWith('.pdf');
}

export function isAudioFile(fileName: string): boolean {
	return AUDIO_EXTENSIONS.includes(getExtension(fileName));
}

export function isVideoFile(fileName: string): boolean {
	return VIDEO_EXTENSIONS.includes(getExtension(fileName));
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

export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
