import type { Elysia } from 'elysia';
import { SERVER_ENV } from '../lib/shared/env';

/**
 * Global Error Handler Middleware
 * Catches all errors and returns consistent error responses
 */
export function errorHandlerMiddleware(app: Elysia) {
	return app.onError(({ code, error, set }) => {
		console.error('[Error]', code, error);

		// Handle different error types
		switch (code) {
			case 'VALIDATION':
				set.status = 400;
				return {
					success: false,
					error: 'Validation error',
					message: error.message
				};

			case 'NOT_FOUND':
				set.status = 404;
				return {
					success: false,
					error: 'Not found',
					message: error.message
				};

			case 'PARSE':
				set.status = 400;
				return {
					success: false,
					error: 'Parse error',
					message: 'Invalid request body'
				};

			default:
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
