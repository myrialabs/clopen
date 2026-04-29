import type { Elysia } from 'elysia';
import { SERVER_ENV } from '../utils/env';

/**
 * Global Error Handler Middleware
 * Catches all errors and returns consistent error responses
 */
export function errorHandlerMiddleware(app: Elysia) {
	return app.onError(({ code, error, set, request }) => {
		// Build a single-line request descriptor so 404s/etc. can be traced
		// back to the offending URL without dumping the full Error stack
		// (which previously logged just "NOT_FOUND" with no path info).
		let reqInfo = '';
		try {
			const url = new URL(request.url);
			reqInfo = `${request.method} ${url.pathname}${url.search}`;
		} catch { /* request.url unavailable */ }

		// Handle different error types
		switch (code) {
			case 'VALIDATION':
				console.error('[Error]', code, reqInfo, error.message);
				set.status = 400;
				return {
					success: false,
					error: 'Validation error',
					message: error.message
				};

			case 'NOT_FOUND':
				// 404s are common in dev (probes, hot-reload pings, deep-link
				// refreshes). Log the path at warn level instead of dumping
				// the full Error stack on every miss.
				console.warn('[404]', reqInfo || '(unknown path)');
				set.status = 404;
				return {
					success: false,
					error: 'Not found',
					message: error.message
				};

			case 'PARSE':
				console.error('[Error]', code, reqInfo);
				set.status = 400;
				return {
					success: false,
					error: 'Parse error',
					message: 'Invalid request body'
				};

			default:
				console.error('[Error]', code, reqInfo, error);
				set.status = 500;
				return {
					success: false,
					error: 'Internal server error',
					message:
						SERVER_ENV.NODE_ENV === 'production'
							? 'An error occurred'
							: error.toString()
				};
		}
	});
}
