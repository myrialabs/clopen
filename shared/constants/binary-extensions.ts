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

/**
 * Image formats only some browsers decode — Safari shows HEIC and TIFF, the
 * others don't. They are tried, and the preview falls back to the file's
 * details and a download where the browser can't show them.
 */
export const BROWSER_DEPENDENT_IMAGE_EXTENSIONS = new Set([
	'.heic', '.heif', '.tiff', '.tif',
]);

/**
 * Audio formats rendered via the `<audio>` element. Support varies by browser
 * (WMA plays nowhere, AIFF only in Safari); the preview falls back to a
 * download when the element can't play the file.
 */
export const AUDIO_EXTENSIONS = new Set([
	'.mp3', '.wav', '.ogg', '.oga', '.flac', '.aac', '.m4a', '.wma', '.opus', '.weba', '.aiff', '.aif',
]);

/**
 * Video formats rendered via the `<video>` element. Whether one plays depends
 * on the browser and the codec inside (AVI, WMV and FLV almost never do); the
 * preview falls back to a download when it can't.
 */
export const VIDEO_EXTENSIONS = new Set([
	'.mp4', '.webm', '.ogv', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v',
	'.mpeg', '.mpg', '.3gp', '.3g2', '.m2ts',
]);

/** Binary extensions that CAN be previewed in the browser (image, audio, video, PDF) */
export const PREVIEWABLE_BINARY_EXTENSIONS = new Set([
	...IMAGE_EXTENSIONS,
	...BROWSER_DEPENDENT_IMAGE_EXTENSIONS,
	...AUDIO_EXTENSIONS,
	...VIDEO_EXTENSIONS,
	// Documents
	'.pdf',
]);

/** Binary extensions that CANNOT be previewed — archives, executables, fonts, databases, etc. */
export const NON_PREVIEWABLE_BINARY_EXTENSIONS = new Set([
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
