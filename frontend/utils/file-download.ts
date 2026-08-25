/**
 * Downloading a project file to the user's device, with progress.
 *
 * The bytes come from `GET /api/files/download` rather than the WebSocket:
 * the WS path base64-encodes the whole file into one message, so nothing is
 * observable until it has all arrived — the user sees no movement and then a
 * finished file. HTTP streams it with a `Content-Length`, which is what makes
 * a real progress bar possible.
 *
 * XHR rather than `fetch`, for the same reason the SSH file browser uses it:
 * it is the only way to get both download progress events and a cancel.
 */

import { authStore } from '$frontend/stores/features/auth.svelte';

export interface FileDownloadProgress {
	transferredBytes: number;
	/** Null while the total is unknown (no computable length and no known size). */
	totalBytes: number | null;
}

export interface FileDownloadOptions {
	/**
	 * Size the caller already knows (e.g. from the file tree), used as the
	 * denominator if the response turns out not to carry a computable length.
	 */
	totalBytes?: number | null;
	onProgress?: (progress: FileDownloadProgress) => void;
	signal?: AbortSignal;
}

/** True for the rejection `fetchFileBlob` throws when the caller cancels. */
export function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Read a file off the server into a blob, reporting progress as it arrives.
 *
 * Rejects with an `AbortError` if `signal` fires, so a cancelled download is
 * distinguishable from a failed one.
 */
export function fetchFileBlob(filePath: string, options: FileDownloadOptions = {}): Promise<Blob> {
	const { totalBytes = null, onProgress, signal } = options;

	const token = authStore.sessionToken;
	if (!token) return Promise.reject(new Error('Not authenticated'));
	if (signal?.aborted) return Promise.reject(new DOMException('Download cancelled', 'AbortError'));

	const params = new URLSearchParams({ path: filePath });

	return new Promise<Blob>((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open('GET', `/api/files/download?${params.toString()}`);
		request.responseType = 'blob';
		request.setRequestHeader('Authorization', `Bearer ${token}`);

		const abort = () => request.abort();
		signal?.addEventListener('abort', abort);
		const detach = () => signal?.removeEventListener('abort', abort);

		request.onprogress = (event) => {
			onProgress?.({
				transferredBytes: event.loaded,
				totalBytes: event.lengthComputable && event.total > 0 ? event.total : totalBytes
			});
		};

		request.onload = () => {
			detach();
			if (request.status >= 200 && request.status < 300) {
				const blob = request.response as Blob;
				onProgress?.({ transferredBytes: blob.size, totalBytes: blob.size });
				resolve(blob);
				return;
			}
			// The route reports why in the body, which is a blob here like any
			// other response — read it rather than losing the reason.
			const body: unknown = request.response;
			if (body instanceof Blob) {
				body
					.text()
					.then((text) => reject(new Error(text.trim() || `HTTP ${request.status}`)))
					.catch(() => reject(new Error(`HTTP ${request.status}`)));
				return;
			}
			reject(new Error(`HTTP ${request.status}`));
		};
		request.onerror = () => {
			detach();
			reject(new Error('Network error during download'));
		};
		request.onabort = () => {
			detach();
			reject(new DOMException('Download cancelled', 'AbortError'));
		};

		request.send();
	});
}

/** Hand a blob to the browser as a file save. */
export function saveBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	URL.revokeObjectURL(url);
}
