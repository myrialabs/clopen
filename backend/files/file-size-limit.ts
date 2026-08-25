/**
 * File Size Limit Validation
 *
 * Enforces a configurable maximum file size on write, upload, zip, and
 * extract operations to prevent disk exhaustion attacks (DoS). The limit
 * is sourced from the `system:settings.maxFileSizeMB` admin setting and
 * defaults to 500MB when the setting is missing or invalid.
 */

import { readSystemSetting } from '../settings/system-settings';

/** Default maximum file size in megabytes when no admin setting is present. */
export const DEFAULT_MAX_FILE_SIZE_MB = 500;

/**
 * Read the current maximum file size (bytes) from system settings.
 * Falls back to the default if the row is missing, malformed, or holds a
 * non-positive value — keeps callers resilient even if the DB is empty
 * (e.g. on first boot before the admin writes any system setting).
 */
export function getMaxFileSize(): number {
	const limitMB = readSystemSetting((settings) => {
		const candidate = Number(settings.maxFileSizeMB);
		return Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
	}, DEFAULT_MAX_FILE_SIZE_MB);
	return Math.floor(limitMB * 1024 * 1024);
}

/**
 * Validate that a file size is within the configured limit.
 * @param size - File size in bytes
 * @throws Error if size is negative or exceeds the configured maximum
 */
export function validateFileSize(size: number): void {
	if (size < 0) {
		throw new Error('Invalid file size: size cannot be negative');
	}
	const limit = getMaxFileSize();
	if (size > limit) {
		const maxMB = Math.floor(limit / (1024 * 1024));
		throw new Error(`File size exceeds maximum allowed size of ${maxMB}MB`);
	}
}
