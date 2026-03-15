/**
 * Database Manager Automated Backup Service
 *
 * Schedules and executes database backups, uploading SQL dumps to AWS S3 or GCS.
 * Uses native WebCrypto (available in Bun) for signing — no external SDK required.
 */

import { nanoid } from 'nanoid';
import { debug } from '$shared/utils/logger';
import type { BackupConfig, BackupRun } from '$shared/types/db-export';
import type { DBConnectionConfig } from '$shared/types/db-manager';
import { listTables, describeTable, getTableData } from './index';
import { generateCreateTableSql, rowsToInsertSql } from './export';
import { decrypt } from './crypto';

// ─── SQL Dump Generator ───────────────────────────────────────────────────────

/**
 * Generate a full SQL dump for a connection, yielding chunks of SQL text.
 * Suitable for piping into cloud storage upload.
 */
async function* generateSqlDump(
	config: DBConnectionConfig
): AsyncGenerator<string> {
	const now = new Date().toISOString();
	yield `-- Clopen Database Backup\n`;
	yield `-- Connection: ${config.name} (${config.type})\n`;
	yield `-- Generated: ${now}\n`;
	yield `-- -----------------------------------------------------------------------\n\n`;

	const tables = await listTables(config);
	const sqlTables = tables.filter((t) => t.type === 'table');

	for (const table of sqlTables) {
		yield `-- Table: ${table.schema ? table.schema + '.' : ''}${table.name}\n`;

		// CREATE TABLE
		const createSql = await generateCreateTableSql(config, table.name, table.schema).catch(() => null);
		if (createSql) yield createSql + '\n';

		// INSERT rows in batches of 500
		const batchSize = 500;
		let offset = 0;
		while (true) {
			const result = await getTableData(config, table.name, table.schema, batchSize, offset);
			if (!result.rows.length) break;
			yield rowsToInsertSql(result.rows, table.name, table.schema, config.type);
			offset += result.rows.length;
			if (result.rows.length < batchSize) break;
		}

		yield '\n';
	}

	yield `-- End of dump\n`;
}

/**
 * Collect all SQL dump chunks into a single Uint8Array.
 */
async function collectDump(config: DBConnectionConfig): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	let totalLen = 0;

	for await (const chunk of generateSqlDump(config)) {
		const bytes = encoder.encode(chunk);
		parts.push(bytes);
		totalLen += bytes.byteLength;
	}

	const result = new Uint8Array(totalLen);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

// ─── AWS S3 Upload ────────────────────────────────────────────────────────────

async function sha256Hex(data: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const keyBuf = key instanceof Uint8Array ? key.buffer as ArrayBuffer : key;
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		keyBuf,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const encoded = new TextEncoder().encode(data);
	return crypto.subtle.sign('HMAC', cryptoKey, encoded.buffer as ArrayBuffer);
}

async function getS3SigningKey(
	secretKey: string,
	dateStamp: string,
	region: string
): Promise<ArrayBuffer> {
	const enc = new TextEncoder();
	const kDate = await hmacSha256(enc.encode('AWS4' + secretKey), dateStamp);
	const kRegion = await hmacSha256(kDate, region);
	const kService = await hmacSha256(kRegion, 's3');
	return hmacSha256(kService, 'aws4_request');
}

/**
 * Upload a Uint8Array to AWS S3 using Signature V4.
 */
async function uploadToS3(
	body: Uint8Array,
	bucket: string,
	key: string,
	region: string,
	accessKeyId: string,
	secretAccessKey: string
): Promise<void> {
	const now = new Date();
	const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
	const dateStamp = amzDate.slice(0, 8);

	const contentHash = await sha256Hex(body);
	const host = `${bucket}.s3.${region}.amazonaws.com`;
	const url = `https://${host}/${key}`;

	const headers: Record<string, string> = {
		host,
		'x-amz-content-sha256': contentHash,
		'x-amz-date': amzDate,
		'content-type': 'application/octet-stream'
	};

	const sortedHeaderKeys = Object.keys(headers).sort();
	const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join('');
	const signedHeaders = sortedHeaderKeys.join(';');

	const canonicalRequest = [
		'PUT',
		'/' + key,
		'',
		canonicalHeaders,
		signedHeaders,
		contentHash
	].join('\n');

	const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		credentialScope,
		await sha256Hex(new TextEncoder().encode(canonicalRequest))
	].join('\n');

	const signingKey = await getS3SigningKey(secretAccessKey, dateStamp, region);
	const signatureBytes = await hmacSha256(signingKey, stringToSign);
	const signature = Array.from(new Uint8Array(signatureBytes))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const response = await fetch(url, {
		method: 'PUT',
		headers: { ...headers, Authorization: authorization },
		body: body.buffer as ArrayBuffer
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`S3 upload failed: ${response.status} ${response.statusText} — ${text}`);
	}
}

// ─── GCS Upload ───────────────────────────────────────────────────────────────

/**
 * Import a PEM-encoded RSA private key for use with SubtleCrypto.
 */
async function importRsaPrivateKey(pemKey: string): Promise<CryptoKey> {
	// Strip PEM headers and decode base64
	const pemBody = pemKey
		.replace(/-----BEGIN [^-]+-----/g, '')
		.replace(/-----END [^-]+-----/g, '')
		.replace(/\s+/g, '');
	const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

	return crypto.subtle.importKey(
		'pkcs8',
		der,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);
}

/**
 * Get a short-lived GCS access token via service account JWT.
 */
async function getGCSAccessToken(clientEmail: string, privateKey: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const iat = now;
	const exp = now + 3600;

	const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');

	const payload = btoa(
		JSON.stringify({
			iss: clientEmail,
			scope: 'https://www.googleapis.com/auth/devstorage.read_write',
			aud: 'https://oauth2.googleapis.com/token',
			iat,
			exp
		})
	)
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');

	const signingInput = `${header}.${payload}`;
	const cryptoKey = await importRsaPrivateKey(privateKey);
	const signatureBytes = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		cryptoKey,
		new TextEncoder().encode(signingInput)
	);
	const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)))
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');

	const jwt = `${signingInput}.${signature}`;

	const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
	});

	if (!tokenResponse.ok) {
		const text = await tokenResponse.text();
		throw new Error(`GCS token request failed: ${tokenResponse.status} — ${text}`);
	}

	const json = (await tokenResponse.json()) as { access_token: string };
	return json.access_token;
}

/**
 * Upload a Uint8Array to Google Cloud Storage using the XML API.
 */
async function uploadToGCS(
	body: Uint8Array,
	bucket: string,
	objectName: string,
	clientEmail: string,
	privateKey: string
): Promise<void> {
	const token = await getGCSAccessToken(clientEmail, privateKey);
	const url = `https://storage.googleapis.com/${bucket}/${encodeURIComponent(objectName)}`;

	const response = await fetch(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(body.byteLength)
		},
		body: body.buffer as ArrayBuffer
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`GCS upload failed: ${response.status} ${response.statusText} — ${text}`);
	}
}

// ─── Backup Orchestration ─────────────────────────────────────────────────────

/**
 * Decrypt sensitive backup config credentials (secret keys, private keys).
 */
async function decryptBackupCredentials(config: BackupConfig): Promise<BackupConfig> {
	const result = { ...config };
	if (result.awsSecretAccessKey) {
		result.awsSecretAccessKey = await decrypt(result.awsSecretAccessKey);
	}
	if (result.gcsPrivateKey) {
		result.gcsPrivateKey = await decrypt(result.gcsPrivateKey);
	}
	return result;
}

/**
 * Run a single backup: dump → upload → record result.
 */
export async function runBackup(
	backupConfig: BackupConfig,
	dbConfig: DBConnectionConfig
): Promise<BackupRun> {
	const run: BackupRun = {
		id: nanoid(),
		configId: backupConfig.id,
		connectionId: dbConfig.id,
		connectionName: dbConfig.name,
		startedAt: new Date().toISOString(),
		success: false
	};

	try {
		const decrypted = await decryptBackupCredentials(backupConfig);

		debug.log('backup', `Starting backup for connection "${dbConfig.name}" (${backupConfig.provider})`);

		// Generate SQL dump in memory
		const dumpBytes = await collectDump(dbConfig);

		// Build storage key
		const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const objectName = `${decrypted.prefix.replace(/\/$/, '')}/${dbConfig.name}_${dateStr}.sql`;

		// Upload to cloud provider
		if (decrypted.provider === 'aws-s3') {
			if (!decrypted.awsRegion || !decrypted.awsAccessKeyId || !decrypted.awsSecretAccessKey) {
				throw new Error('AWS credentials incomplete (region, accessKeyId, secretAccessKey required)');
			}
			await uploadToS3(
				dumpBytes,
				decrypted.bucket,
				objectName,
				decrypted.awsRegion,
				decrypted.awsAccessKeyId,
				decrypted.awsSecretAccessKey
			);
		} else {
			if (!decrypted.gcsClientEmail || !decrypted.gcsPrivateKey) {
				throw new Error('GCS credentials incomplete (clientEmail, privateKey required)');
			}
			await uploadToGCS(
				dumpBytes,
				decrypted.bucket,
				objectName,
				decrypted.gcsClientEmail,
				decrypted.gcsPrivateKey
			);
		}

		run.completedAt = new Date().toISOString();
		run.success = true;
		run.fileSize = dumpBytes.byteLength;
		run.storagePath = `${decrypted.provider === 'aws-s3' ? 's3' : 'gs'}://${decrypted.bucket}/${objectName}`;

		debug.log('backup', `Backup complete: ${run.storagePath} (${dumpBytes.byteLength} bytes)`);
	} catch (err) {
		run.completedAt = new Date().toISOString();
		run.success = false;
		run.error = err instanceof Error ? err.message : 'Unknown backup error';
		debug.error('backup', `Backup failed for "${dbConfig.name}": ${run.error}`);
	}

	return run;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/** Returns true if the backup is due to run right now (within the current minute). */
function isDue(config: BackupConfig, now: Date): boolean {
	const hour = now.getUTCHours();
	const minute = now.getUTCMinutes();

	// Only check at the top of the hour (minute 0)
	if (minute !== 0) return false;
	if (config.hour !== hour) return false;

	switch (config.frequency) {
		case 'hourly':
			return true; // run every hour regardless of hour setting
		case 'daily':
			return true;
		case 'weekly': {
			const dayOfWeek = now.getUTCDay();
			return config.dayOfWeek === dayOfWeek;
		}
		case 'monthly': {
			const dayOfMonth = now.getUTCDate();
			return config.dayOfMonth === dayOfMonth;
		}
		default:
			return false;
	}
}

/**
 * Special case: hourly backups run every hour at minute 0, ignoring the `hour` field.
 */
function isHourlyDue(config: BackupConfig, now: Date): boolean {
	return config.frequency === 'hourly' && now.getUTCMinutes() === 0;
}

/**
 * Start the backup scheduler. Should be called once at server startup.
 * Checks for due backups every minute.
 */
export function startBackupScheduler(): void {
	if (schedulerTimer) return;

	schedulerTimer = setInterval(async () => {
		try {
			const { dbBackupQueries } = await import('../database/queries/db-backup-queries');
			const { getDecryptedConnection } = await import('../ws/database/connections');
			const { decryptConnectionCredentials } = await import('./crypto');
			const { settingsQueries } = await import('../database/queries');

			const configs = dbBackupQueries.listEnabled();
			if (!configs.length) return;

			const now = new Date();

			for (const config of configs) {
				if (!isDue(config, now) && !isHourlyDue(config, now)) continue;

				try {
					// Load DB connection config (with decrypted credentials)
					const STORAGE_KEY = 'db-manager:connections';
					const setting = settingsQueries.get(STORAGE_KEY);
					if (!setting) continue;
					const connections = JSON.parse(setting.value as string) as import('$shared/types/db-manager').DBConnectionConfig[];
					const rawConn = connections.find((c) => c.id === config.connectionId);
					if (!rawConn) continue;
					const dbConfig = await decryptConnectionCredentials(rawConn);

					const run = await runBackup(config, dbConfig);
					dbBackupQueries.addRun(run);
					dbBackupQueries.update(config.id, {
						lastRunAt: run.startedAt,
						lastRunSuccess: run.success,
						lastRunError: run.error ?? undefined
					});
					dbBackupQueries.pruneRuns(config.id, config.retentionDays);
				} catch (err) {
					debug.error('backup', `Scheduler error for config ${config.id}: ${err}`);
				}
			}
		} catch (err) {
			debug.error('backup', `Scheduler tick error: ${err}`);
		}
	}, 60_000); // check every minute

	debug.log('backup', 'Backup scheduler started');
}

export function stopBackupScheduler(): void {
	if (schedulerTimer) {
		clearInterval(schedulerTimer);
		schedulerTimer = null;
		debug.log('backup', 'Backup scheduler stopped');
	}
}
