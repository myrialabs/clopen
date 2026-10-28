/**
 * User domain helper functions
 */

/**
 * Generate a consistent color from a string
 */
export function generateColorFromString(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}

	const hue = hash % 360;
	return `hsl(${hue}, 70%, 50%)`;
}

/**
 * Get initials from name
 */
export function getInitials(name: string): string {
	const trimmed = name.trim();

	// Try to get initials from first two words
	const words = trimmed.split(' ');
	if (words.length >= 2) {
		return (words[0][0] + words[1][0]).toUpperCase();
	}

	// Fallback to first 2 characters
	return trimmed.substring(0, 2).toUpperCase();
}
