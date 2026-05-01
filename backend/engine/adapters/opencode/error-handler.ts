/**
 * Open Code SDK error handler.
 *
 * Mirrors the Claude/Codex/Qwen pattern: swallow abort errors and surface a
 * sanitised message. OpenCode's `session.error` event carries a structured
 * `{ name, data }` payload from the SDK — `formatSessionError` extracts a
 * human-readable string from it before the adapter throws.
 */

import type { EventSessionError } from '@opencode-ai/sdk';

/**
 * Extract a human-readable error message from an OpenCode `session.error` event.
 *
 * OpenCode SDK errors follow `{ name: string, data: { message, statusCode?,
 * providerID?, responseBody? } }`. We don't prepend the error class name (e.g.
 * "APIError") since those are SDK implementation details.
 */
export function formatSessionError(errorProps: EventSessionError['properties']): string {
	const { error } = errorProps;
	if (!error) return 'Unknown Open Code error';

	const errObj = error as Record<string, any>;
	const name = errObj.name || '';
	const dataMsg = errObj.data?.message || '';
	const statusCode = errObj.data?.statusCode;
	const providerID = errObj.data?.providerID;
	const responseBody = errObj.data?.responseBody;

	let errorMsg = 'Unknown Open Code error';
	if (dataMsg) {
		errorMsg = dataMsg;
	} else if (responseBody) {
		try {
			const body = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
			errorMsg = body?.error?.message || body?.message || String(responseBody);
		} catch {
			errorMsg = String(responseBody);
		}
	} else if (name) {
		errorMsg = name;
	} else if (typeof error === 'string') {
		errorMsg = error;
	} else {
		errorMsg = JSON.stringify(error);
	}

	if (statusCode) {
		errorMsg += ` (status ${statusCode})`;
	}
	if (providerID) {
		errorMsg += ` [provider: ${providerID}]`;
	}
	return errorMsg;
}

/**
 * Swallow expected abort errors; re-throw everything else unchanged.
 *
 * OpenCode's catch handler is intentionally thin — `session.error` events are
 * already pre-formatted into Error objects upstream, so we don't need a second
 * normalisation pass here.
 */
export function handleStreamError(error: unknown): void {
	if (error instanceof Error) {
		if (error.name === 'AbortError' || error.message.includes('aborted')) {
			return;
		}
	}
	throw error;
}
