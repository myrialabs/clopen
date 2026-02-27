/**
 * Async utility functions
 */

/**
 * Sleep/delay for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
