/**
 * Shared API Types for Elysia Server
 */

export interface ApiResponse<T = any> {
	success: boolean;
	data?: T;
	error?: string;
	message?: string;
}

export interface PaginationParams {
	page?: number;
	limit?: number;
	offset?: number;
}

export interface ErrorResponse {
	success: false;
	error: string;
	message: string;
}

// More types will be added as needed during Phase 2 migration
