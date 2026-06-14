/**
 * HTTP upload route for files.
 *
 * The WebSocket-based upload path was wedging on the Vite dev proxy for
 * large transfers — the proxy reports `write EPIPE` and the client request
 * times out. HTTP is purpose-built for streaming large request bodies and
 * the same Vite proxy forwards it cleanly, so we route uploads here.
 *
 * Auth: `Authorization: Bearer <session-token>` (same token issued by
 * `auth:login` and stored in `localStorage` on the frontend).
 *
 * Query: `targetPath`, `fileName`, `fileSize` (decimal bytes).
 *
 * Body: raw file bytes (no multipart wrapping).
 */

import { Elysia } from 'elysia';
import { join } from 'node:path';
import { link, mkdir, stat, unlink } from 'node:fs/promises';

import { debug } from '$shared/utils/logger';
import { hashToken } from '../auth/tokens';
import { authQueries, fileAuditLogQueries } from '../database/queries';
import { findContainingProjectId, requireFilePathAccessFor } from '../ws/files/path-access';
import { clientIpFromRequest } from '../utils/client-ip';
import { validateFileSize } from '../files/file-size-limit';
import { uploadTempCleanup } from './upload-temp-cleanup';

type AuthIdentity = { userId: string; role: string };

function authenticate(request: Request): AuthIdentity {
	const header = request.headers.get('authorization') || request.headers.get('Authorization');
	if (!header || !header.toLowerCase().startsWith('bearer ')) {
		throw Object.assign(new Error('Authorization required'), { status: 401 });
	}
	const token = header.slice(7).trim();
	if (!token) {
		throw Object.assign(new Error('Authorization required'), { status: 401 });
	}
	const session = authQueries.getSessionByTokenHash(hashToken(token));
	if (!session) {
		throw Object.assign(new Error('Invalid session token'), { status: 401 });
	}
	if (new Date(session.expires_at) < new Date()) {
		throw Object.assign(new Error('Session expired'), { status: 401 });
	}
	const user = authQueries.getUserById(session.user_id);
	if (!user) {
		throw Object.assign(new Error('User not found'), { status: 401 });
	}
	authQueries.updateLastActive(session.id);
	return { userId: user.id, role: user.role };
}

export const filesUploadRoute = new Elysia().post('/api/files/upload', async ({ request, query, server }) => {
	let identity: AuthIdentity;
	try {
		identity = authenticate(request);
	} catch (error) {
		const status = (error as { status?: number }).status ?? 401;
		const message = error instanceof Error ? error.message : 'Unauthorized';
		return new Response(message, { status });
	}

	const targetPathParam = typeof query.targetPath === 'string' ? query.targetPath : '';
	const fileNameParam = typeof query.fileName === 'string' ? query.fileName : '';
	const fileSizeParam = typeof query.fileSize === 'string' ? Number(query.fileSize) : NaN;

	if (!targetPathParam || !fileNameParam) {
		return new Response('Missing required query parameters: targetPath, fileName', { status: 400 });
	}
	if (!Number.isFinite(fileSizeParam) || fileSizeParam < 0) {
		return new Response('Invalid fileSize query parameter', { status: 400 });
	}

	const ipAddress = clientIpFromRequest(request, server);
	const userAgent = request.headers.get('user-agent') ?? undefined;
	const projectId = await findContainingProjectId(`${targetPathParam}/${fileNameParam}`);

	try {
		validateFileSize(fileSizeParam);
	} catch (error) {
		fileAuditLogQueries.logOperation({
			userId: identity.userId,
			projectId,
			action: 'upload',
			filePath: `${targetPathParam}/${fileNameParam}`,
			fileSize: fileSizeParam,
			ipAddress,
			userAgent,
			success: false,
			errorMessage: 'File too large'
		});
		return new Response(error instanceof Error ? error.message : 'Invalid file size', { status: 413 });
	}

	let resolvedTarget: string;
	let resolvedFinal: string;
	try {
		resolvedTarget = await requireFilePathAccessFor(targetPathParam, identity.role, identity.userId);
		const tentativeFinal = join(resolvedTarget, fileNameParam);
		resolvedFinal = await requireFilePathAccessFor(tentativeFinal, identity.role, identity.userId);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Access denied';
		fileAuditLogQueries.logOperation({
			userId: identity.userId,
			projectId,
			action: 'upload',
			filePath: `${targetPathParam}/${fileNameParam}`,
			fileSize: fileSizeParam,
			ipAddress,
			userAgent,
			success: false,
			errorMessage: 'Path access denied'
		});
		return new Response(message, { status: 403 });
	}

	try {
		const targetStat = await stat(resolvedTarget).catch(() => null);
		if (!targetStat) {
			await mkdir(resolvedTarget, { recursive: true });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to prepare target directory';
		return new Response(message, { status: 500 });
	}

	// Early existence check — fast-path rejection before streaming the body
	if (await Bun.file(resolvedFinal).exists()) {
		fileAuditLogQueries.logOperation({
			userId: identity.userId,
			projectId,
			action: 'upload',
			filePath: resolvedFinal,
			fileSize: fileSizeParam,
			ipAddress,
			userAgent,
			success: false,
			errorMessage: 'File already exists'
		});
		return new Response('File already exists', { status: 409 });
	}

	if (!request.body) {
		return new Response('Request body is empty', { status: 400 });
	}

	// Stream to a unique temp file, then atomically link into place.
	// link() uses O_EXCL semantics — fails with EEXIST if final already exists.
	// The final path only appears with full content (no partial-file visibility).
	const tempPath = `${resolvedFinal}.${crypto.randomUUID()}.partial`;
	uploadTempCleanup.register(tempPath);
	const writer = Bun.file(tempPath).writer();
	let written = 0;

	const cleanupTemp = async () => {
		uploadTempCleanup.deregister(tempPath);
		try { await writer.end(); } catch { /* best-effort */ }
		try { await unlink(tempPath); } catch { /* best-effort */ }
	};

	try {
		const reader = request.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const incoming = value.byteLength;
			if (written + incoming > fileSizeParam) {
				await cleanupTemp();
				return new Response('Received more bytes than declared file size', { status: 400 });
			}
			writer.write(value);
			written += incoming;
		}

		await writer.end();

		if (written !== fileSizeParam) {
			uploadTempCleanup.deregister(tempPath);
			await unlink(tempPath).catch(() => {});
			return new Response(`Incomplete upload: received ${written} of ${fileSizeParam} bytes`, { status: 400 });
		}

		try {
			validateFileSize(written);
		} catch (error) {
			uploadTempCleanup.deregister(tempPath);
			await unlink(tempPath).catch(() => {});
			fileAuditLogQueries.logOperation({
				userId: identity.userId,
				projectId,
				action: 'upload',
				filePath: resolvedFinal,
				fileSize: written,
				ipAddress,
				userAgent,
				success: false,
				errorMessage: 'File too large'
			});
			return new Response(error instanceof Error ? error.message : 'File too large', { status: 413 });
		}

		// Atomic exclusive link — fails with EEXIST if final already exists
		try {
			await link(tempPath, resolvedFinal);
		} catch (error: unknown) {
			if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
				uploadTempCleanup.deregister(tempPath);
				await unlink(tempPath).catch(() => {});
				return new Response('File already exists', { status: 409 });
			}
			await unlink(tempPath).catch(() => {});
			fileAuditLogQueries.logOperation({
				userId: identity.userId,
				projectId,
				action: 'upload',
				filePath: resolvedFinal,
				fileSize: written,
				ipAddress,
				userAgent,
				success: false,
				errorMessage: `link() failed: ${(error as Error).message}`
			});
			throw error;
		}

		uploadTempCleanup.deregister(tempPath);
		// Clean up temp — the real file is now the hard-link
		await unlink(tempPath).catch(() => {});

		const stats = await stat(resolvedFinal);

		fileAuditLogQueries.logOperation({
			userId: identity.userId,
			projectId,
			action: 'upload',
			filePath: resolvedFinal,
			fileSize: stats.size,
			ipAddress,
			userAgent
		});

		return Response.json({
			message: 'File uploaded successfully',
			path: resolvedFinal,
			size: stats.size,
			modified: stats.mtime.toISOString()
		});
	} catch (error) {
		uploadTempCleanup.deregister(tempPath);
		await unlink(tempPath).catch(() => {});
		debug.error('file', 'HTTP upload error:', error);
		const message = error instanceof Error ? error.message : 'Upload failed';
		fileAuditLogQueries.logOperation({
			userId: identity.userId,
			projectId,
			action: 'upload',
			filePath: resolvedFinal,
			fileSize: written,
			ipAddress,
			userAgent,
			success: false,
			errorMessage: message
		});
		return new Response(message, { status: 500 });
	}
});
