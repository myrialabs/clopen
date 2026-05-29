/**
 * HTTP routes for per-user custom notification sounds.
 *
 * Storage layout: ~/.clopen[-dev]/audio/<userId>/notification.<ext>
 * One file per user — uploading replaces any previous file (including different ext).
 *
 * Auth: `Authorization: Bearer <session-token>` (same token issued by auth:login).
 */

import { Elysia } from 'elysia';
import { join } from 'node:path';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';

import { debug } from '$shared/utils/logger';
import { hashToken } from '../auth/tokens';
import { authQueries } from '../database/queries';
import { getClopenDir } from '../utils/paths';
import {
	NOTIFICATION_SOUND_ALLOWED_EXTS,
	NOTIFICATION_SOUND_MAX_BYTES,
	isValidNotificationSoundExt
} from '$shared/constants/notification-sounds';

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

function getUserAudioDir(userId: string): string {
	return join(getClopenDir(), 'audio', userId);
}

const EXT_CONTENT_TYPES: Record<string, string> = {
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	m4a: 'audio/mp4'
};

async function findExistingCustomFile(dir: string): Promise<{ path: string; ext: string } | null> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return null;
	}
	for (const ext of NOTIFICATION_SOUND_ALLOWED_EXTS) {
		const name = `notification.${ext}`;
		if (entries.includes(name)) {
			return { path: join(dir, name), ext };
		}
	}
	return null;
}

export const audioRoute = new Elysia()
	.post('/api/audio/upload', async ({ request, query }) => {
		let identity: AuthIdentity;
		try {
			identity = authenticate(request);
		} catch (error) {
			const status = (error as { status?: number }).status ?? 401;
			const message = error instanceof Error ? error.message : 'Unauthorized';
			return new Response(message, { status });
		}

		const extParam = typeof query.ext === 'string' ? query.ext.toLowerCase() : '';
		const fileSizeParam = typeof query.fileSize === 'string' ? Number(query.fileSize) : NaN;

		if (!isValidNotificationSoundExt(extParam)) {
			return new Response(
				`Unsupported audio format. Allowed: ${NOTIFICATION_SOUND_ALLOWED_EXTS.join(', ')}`,
				{ status: 400 }
			);
		}
		if (!Number.isFinite(fileSizeParam) || fileSizeParam <= 0) {
			return new Response('Invalid fileSize query parameter', { status: 400 });
		}
		if (fileSizeParam > NOTIFICATION_SOUND_MAX_BYTES) {
			return new Response(
				`File too large. Max ${NOTIFICATION_SOUND_MAX_BYTES} bytes (${Math.round(NOTIFICATION_SOUND_MAX_BYTES / 1024)} KB)`,
				{ status: 413 }
			);
		}
		if (!request.body) {
			return new Response('Request body is empty', { status: 400 });
		}

		const userDir = getUserAudioDir(identity.userId);
		await mkdir(userDir, { recursive: true });

		const finalPath = join(userDir, `notification.${extParam}`);
		const tempPath = `${finalPath}.${crypto.randomUUID()}.partial`;
		const writer = Bun.file(tempPath).writer();
		let written = 0;

		const cleanupTemp = async () => {
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
				if (written + incoming > NOTIFICATION_SOUND_MAX_BYTES) {
					await cleanupTemp();
					return new Response('File too large', { status: 413 });
				}
				writer.write(value);
				written += incoming;
			}

			await writer.end();

			if (written !== fileSizeParam) {
				await unlink(tempPath).catch(() => {});
				return new Response(`Incomplete upload: received ${written} of ${fileSizeParam} bytes`, {
					status: 400
				});
			}

			// Remove any previously-uploaded file with a different extension.
			const existing = await findExistingCustomFile(userDir);
			if (existing && existing.path !== finalPath) {
				await unlink(existing.path).catch(() => {});
			}

			await rename(tempPath, finalPath);
			const stats = await stat(finalPath);

			return Response.json({
				message: 'Sound uploaded successfully',
				ext: extParam,
				size: stats.size,
				modified: stats.mtime.toISOString()
			});
		} catch (error) {
			await cleanupTemp();
			debug.error('notification', 'HTTP audio upload error:', error);
			const message = error instanceof Error ? error.message : 'Upload failed';
			return new Response(message, { status: 500 });
		}
	})
	.get('/api/audio/custom/meta', async ({ request }) => {
		let identity: AuthIdentity;
		try {
			identity = authenticate(request);
		} catch (error) {
			const status = (error as { status?: number }).status ?? 401;
			const message = error instanceof Error ? error.message : 'Unauthorized';
			return new Response(message, { status });
		}

		const userDir = getUserAudioDir(identity.userId);
		const existing = await findExistingCustomFile(userDir);
		if (!existing) {
			return Response.json({ exists: false });
		}
		const stats = await stat(existing.path).catch(() => null);
		return Response.json({
			exists: true,
			ext: existing.ext,
			size: stats?.size ?? 0,
			modified: stats?.mtime.toISOString() ?? null
		});
	})
	.get('/api/audio/custom', async ({ request }) => {
		let identity: AuthIdentity;
		try {
			identity = authenticate(request);
		} catch (error) {
			const status = (error as { status?: number }).status ?? 401;
			const message = error instanceof Error ? error.message : 'Unauthorized';
			return new Response(message, { status });
		}

		const userDir = getUserAudioDir(identity.userId);
		const existing = await findExistingCustomFile(userDir);
		if (!existing) {
			return new Response('No custom sound', { status: 404 });
		}

		const file = Bun.file(existing.path);
		return new Response(file, {
			headers: {
				'Content-Type': EXT_CONTENT_TYPES[existing.ext] ?? 'application/octet-stream',
				'Cache-Control': 'no-cache'
			}
		});
	})
	.delete('/api/audio/custom', async ({ request }) => {
		let identity: AuthIdentity;
		try {
			identity = authenticate(request);
		} catch (error) {
			const status = (error as { status?: number }).status ?? 401;
			const message = error instanceof Error ? error.message : 'Unauthorized';
			return new Response(message, { status });
		}

		const userDir = getUserAudioDir(identity.userId);
		const existing = await findExistingCustomFile(userDir);
		if (existing) {
			await unlink(existing.path).catch(() => {});
		}
		return Response.json({ message: 'Custom sound removed' });
	});
