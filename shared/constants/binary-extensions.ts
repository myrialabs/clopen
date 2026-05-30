/**
 * Shared binary file extension constants.
 * Single source of truth used by both backend (file-type-detection) and frontend (file-type).
 */

/**
 * Image formats browsers can render directly in an `<img>` tag.
 * Only these are previewed — formats the browser can't decode (TIFF/HEIC/…)
 * are treated as non-previewable binaries to avoid costly server-side transcoding.
 */
export const IMAGE_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.apng', '.jfif',
]);

/** Audio formats rendered via the `<audio>` element. */
export const AUDIO_EXTENSIONS = new Set([
	'.mp3', '.wav', '.ogg', '.oga', '.flac', '.aac', '.m4a', '.wma', '.opus', '.weba', '.aiff', '.aif',
]);

/** Video formats rendered via the `<video>` element. */
export const VIDEO_EXTENSIONS = new Set([
	'.mp4', '.webm', '.ogv', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v',
	'.mpeg', '.mpg', '.3gp', '.3g2', '.m2ts',
]);

/** Binary extensions that CAN be previewed in the browser (image, audio, video, PDF) */
export const PREVIEWABLE_BINARY_EXTENSIONS = new Set([
	...IMAGE_EXTENSIONS,
	...AUDIO_EXTENSIONS,
	...VIDEO_EXTENSIONS,
	// Documents
	'.pdf',
]);

/** Binary extensions that CANNOT be previewed — archives, executables, fonts, databases, etc. */
export const NON_PREVIEWABLE_BINARY_EXTENSIONS = new Set([
	// Images the browser can't render natively (shown as a downloadable binary)
	'.tiff', '.tif', '.heic', '.heif',
	// Archives
	'.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.zst', '.lz4',
	// Office documents
	'.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
	// Executables & compiled
	'.exe', '.dll', '.com', '.bin', '.dat', '.pak', '.res',
	'.beam', '.pyc', '.pyo', '.class', '.o', '.obj', '.so', '.dylib', '.a',
	'.lib', '.wasm', '.bc', '.pdb', '.dSYM',
	// Fonts
	'.woff', '.woff2', '.ttf', '.eot', '.otf',
	// Databases
	'.sqlite', '.db', '.mdb',
	// Disk images & other
	'.iso', '.dmg', '.img', '.swf', '.swc',
]);

/** All known binary extensions (union of previewable + non-previewable) */
export const ALL_BINARY_EXTENSIONS = new Set([
	...PREVIEWABLE_BINARY_EXTENSIONS,
	...NON_PREVIEWABLE_BINARY_EXTENSIONS,
]);
