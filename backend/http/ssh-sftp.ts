/**
 * HTTP routes for SFTP file transfer.
 *
 * Same reasoning as `/api/files/upload`: the WebSocket wedges on sustained
 * binary transfer behind the Vite dev proxy, while HTTP streams cleanly through
 * it. Download is here too, so the browser can save a remote file straight to
 * disk without buffering it in JavaScript first.
 *
 * Auth: `Authorization: Bearer <session-token>`, then the same ownership check
 * the WS handlers use — a token is not enough, the caller must own the host.
 */

import { Elysia } from 'elysia';
import { Readable } from 'node:stream';

import { debug } from '$shared/utils/logger';
import { sshConnectionQueries } from '../database/queries';
import { joinRemote, sftpService } from '../ssh/sftp';
import { authenticateRequest } from './bearer-auth';

/** Resolve the caller and confirm they own the SSH connection they named. */
function authorizeConnection(request: Request, connectionId: string): void {
	const identity = authenticateRequest(request);
	const connection = sshConnectionQueries.getForUser(
		connectionId,
		identity.userId,
		identity.role === 'admin'
	);
	if (!connection) {
		throw Object.assign(new Error('ssh connection not found'), { status: 404 });
	}
}

function errorResponse(error: unknown, fallbackStatus: number): Response {
	const status = (error as { status?: number }).status ?? fallbackStatus;
	const message = error instanceof Error ? error.message : 'Request failed';
	return new Response(message, { status });
}

export const sshSftpRoute = new Elysia()
	.get('/api/ssh/sftp/download', async ({ request, query }) => {
		const connectionId = typeof query.connectionId === 'string' ? query.connectionId : '';
		const path = typeof query.path === 'string' ? query.path : '';
		if (!connectionId || !path) {
			return new Response('Missing required query parameters: connectionId, path', { status: 400 });
		}

		try {
			authorizeConnection(request, connectionId);
		} catch (error) {
			return errorResponse(error, 401);
		}

		try {
			const { stream, size, name } = await sftpService.openDownload(connectionId, path);
			// Stream straight through: a large remote file must never be buffered
			// in this process just to be handed to the browser.
			const body = Readable.toWeb(stream) as unknown as ReadableStream;
			// Typed by name, the way Bun types a local file — a blob built from
			// this response only plays in <video> or renders in a PDF frame if the
			// type came across with it. Nothing is read from disk here; Bun.file
			// infers the type from the extension alone.
			const contentType = Bun.file(name).type || 'application/octet-stream';
			return new Response(body, {
				headers: {
					'Content-Type': contentType,
					'Content-Length': String(size),
					'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
				}
			});
		} catch (error) {
			debug.error('ssh', 'SFTP download failed:', error);
			return errorResponse(error, 500);
		}
	})

	.post('/api/ssh/sftp/upload', async ({ request, query }) => {
		const connectionId = typeof query.connectionId === 'string' ? query.connectionId : '';
		const targetPath = typeof query.targetPath === 'string' ? query.targetPath : '';
		const fileName = typeof query.fileName === 'string' ? query.fileName : '';
		if (!connectionId || !targetPath || !fileName) {
			return new Response('Missing required query parameters: connectionId, targetPath, fileName', {
				status: 400
			});
		}
		if (fileName.includes('/')) {
			return new Response('fileName must not contain a path separator', { status: 400 });
		}

		try {
			authorizeConnection(request, connectionId);
		} catch (error) {
			return errorResponse(error, 401);
		}

		if (!request.body) {
			return new Response('Request body is empty', { status: 400 });
		}

		const remotePath = joinRemote(targetPath, fileName);

		try {
			const { stream, done } = await sftpService.openUpload(connectionId, remotePath);

			const reader = request.body.getReader();
			let written = 0;
			try {
				while (true) {
					const { done: finished, value } = await reader.read();
					if (finished) break;
					if (!value) continue;
					// Respect backpressure: an SFTP channel is far slower than the
					// browser's upload, and ignoring `write`'s return value would
					// queue the whole file in memory.
					if (!stream.write(value)) {
						await new Promise<void>((resolvePromise) => stream.once('drain', resolvePromise));
					}
					written += value.byteLength;
				}
			} catch (error) {
				stream.destroy();
				throw error;
			}

			stream.end();
			await done;

			return Response.json({ path: remotePath, size: written });
		} catch (error) {
			debug.error('ssh', 'SFTP upload failed:', error);
			return errorResponse(error, 500);
		}
	});
