/**
 * Document Title Badge Service
 *
 * Prefixes the document title with the count of non-idle status
 * indicators across all projects (streaming, waiting input, unread),
 * e.g. "(3) Clopen". A count of 0 restores the plain title.
 */

let baseTitle: string | null = null;
let currentCount = -1; // -1 = not yet applied

/**
 * Update the document title badge.
 *
 * @param count  Number of active indicators (0 = no prefix)
 */
export function updateTitleBadge(count: number): void {
	// Avoid unnecessary writes
	if (count === currentCount) return;
	currentCount = count;

	// Capture the plain title once, stripping any stale prefix
	if (baseTitle === null) {
		baseTitle = document.title.replace(/^\(\d+\)\s*/, '');
	}

	document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
}
