/**
 * HTTP download route for files.
 *
 * The counterpart to `/api/files/upload`, and it exists for the same reason
 * plus one more. Reading a file over the WebSocket (`files:read-content`)
 * base64-encodes the whole thing into a single message: the transfer is
 * invisible until it lands, it costs a third more bytes on the wire, and both
 * ends hold the entire file in memory. Streaming over HTTP with a known
 * `Content-Length` lets the browser report progress while the bytes arrive.
 *
 * Auth: `Authorization: Bearer <session-token>` (same token as the upload
 * route), followed by the same project-scoped path check the WS handlers use.
 *
 * Query: `path` (absolute path of the file to download).
 */

import { Elysia } from 'elysia';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { debug } from '$shared/utils/logger';
import { fileAuditLogQueries } from '../database/queries';
import { findContainingProjectId, requireFilePathAccessFor } from '../ws/files/path-access';
import { clientIpFromRequest } from '../utils/client-ip';
import { authenticateRequest, type AuthIdentity } from './bearer-auth';

export const filesDownloadRoute = new Elysia().get('/api/files/download', async ({ request, query, server }) => {
	let identity: AuthIdentity;
	try {
		identity = authenticateRequest(request);
	} catch (error) {
		const status = (error as { status?: number }).status ?? 401;
		const message = error instanceof Error ? error.message : 'Unauthorized';
		return new Response(message, { status });
	}

	const pathParam = typeof query.path === 'string' ? query.path : '';
	if (!pathParam) {
		return new Response('Missing required query parameter: path', { status: 400 });
	}

	const ipAddress = clientIpFromRequest(request, server);
	const userAgent = request.headers.get('user-agent') ?? undefined;
	const projectId = await findContainingProjectId(pathParam);

	const logFailure = (message: string, size: number | null = null) => {
		fileAuditLogQueries.logOperation({
			userId: identity.userId,
			projectId,
			action: 'download',
			filePath: pathParam,
			fileSize: size,
			ipAddress,
			userAgent,
			success: false,
			errorMessage: message
		});
	};

	let resolvedPath: string;
	try {
		resolvedPath = await requireFilePathAccessFor(pathParam, identity.role, identity.userId);
	} catch (error) {
		logFailure('Path access denied');
		return new Response(error instanceof Error ? error.message : 'Access denied', { status: 403 });
	}

	try {
		const stats = await stat(resolvedPath).catch(() => null);
		if (!stats) {
			logFailure('File not found');
			return new Response('File not found', { status: 404 });
		}
		if (stats.isDirectory()) {
			logFailure('Not a file');
			return new Response('Cannot download a directory — compress it first', { status: 400 });
		}

		const file = Bun.file(resolvedPath);

		const name = basename(resolvedPath);

		fileAuditLogQueries.logOperation({
			userId: identity.userId,
			projectId,
			action: 'download',
			filePath: resolvedPath,
			fileSize: stats.size,
			ipAddress,
			userAgent
		});

		// Streamed straight from disk — a large file must never be buffered in
		// this process just to be handed to the browser. `Content-Length` is what
		// makes the client's progress event computable, so it is always set.
		return new Response(file.stream(), {
			headers: {
				'Content-Type': file.type || 'application/octet-stream',
				'Content-Length': String(stats.size),
				'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
			}
		});
	} catch (error) {
		debug.error('file', 'HTTP download error:', error);
		const message = error instanceof Error ? error.message : 'Download failed';
		logFailure(message);
		return new Response(message, { status: 500 });
	}
});
