import { stat, unlink } from 'node:fs/promises';

import { debug } from '$shared/utils/logger';

const CLEANUP_INTERVAL_MS = 60 * 60_000;
const TEMP_FILE_AGE_MS = 2 * 60 * 60_000;

class UploadTempCleanup {
	private timer: ReturnType<typeof setInterval> | null = null;
	private activeTemps = new Map<string, number>();

	register(tempPath: string): void {
		this.activeTemps.set(tempPath, Date.now());
	}

	deregister(tempPath: string): void {
		this.activeTemps.delete(tempPath);
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
	}

	private async cleanup(): Promise<void> {
		const now = Date.now();
		let removed = 0;

		for (const [tempPath, createdAt] of this.activeTemps) {
			if (now - createdAt <= TEMP_FILE_AGE_MS) continue;
			try {
				await unlink(tempPath);
				this.activeTemps.delete(tempPath);
				removed++;
			} catch {
				this.activeTemps.delete(tempPath);
			}
		}

		if (removed > 0) {
			debug.log('file', `Upload temp cleanup: removed ${removed} stale partial file(s)`);
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}

export const uploadTempCleanup = new UploadTempCleanup();
