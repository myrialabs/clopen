/**
 * Terminal domain helper functions
 */

// Bun-compatible existsSync implementation
export async function existsSync(filePath: string): Promise<boolean> {
	try {
		const file = Bun.file(filePath);
		await file.stat();
		return true;
	} catch {
		return false;
	}
}
