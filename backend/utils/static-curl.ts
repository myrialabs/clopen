/**
 * Static curl binary management.
 *
 * Some install scripts clopen runs (notably OpenCode's) invoke `curl`
 * internally. When the host system lacks curl and cannot install it
 * non-interactively (e.g. Linux without root), clopen falls back to
 * downloading a verified static curl binary from the stunnel/static-curl
 * project into ~/.clopen/bin/curl and prepends that directory to PATH
 * when spawning the install subprocess.
 *
 * Supply-chain hardening:
 *  - Version + SHA256 for each arch is pinned in source. If the remote
 *    asset ever changes the hash mismatch aborts the download and the
 *    cached/final file is never touched.
 *  - stunnel/static-curl is a reproducible-build project maintained by
 *    the stunnel team. Release: https://github.com/stunnel/static-curl
 */

import { existsSync, readdirSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { untar, unxz } from '@myrialabs/zipkit';
import { debug } from '$shared/utils/logger';
import { getClopenDir } from '$backend/utils/paths';
import { resolveBinary } from '$backend/utils/cli';

export const STATIC_CURL_VERSION = '8.19.0';

export interface StaticCurlAsset {
	/** Key like "linux-x86_64-glibc". */
	archKey: string;
	url: string;
	sha256: string;
	version: string;
}

function makeAsset(archKey: string, sha256: string): StaticCurlAsset {
	return {
		archKey,
		url: `https://github.com/stunnel/static-curl/releases/download/${STATIC_CURL_VERSION}/curl-${archKey}-${STATIC_CURL_VERSION}.tar.xz`,
		sha256,
		version: STATIC_CURL_VERSION
	};
}

// Hashes verified by downloading each archive and computing shasum -a 256
// against stunnel/static-curl 8.19.0 release on 2026-04-23.
const PINNED_ASSETS: Record<string, StaticCurlAsset> = {
	'linux-x86_64-glibc': makeAsset('linux-x86_64-glibc', '9c70e3ac08a6d8e211a891fe2fc871a9cd3314c291adb5bb1a38e7355ce98ff7'),
	'linux-x86_64-musl': makeAsset('linux-x86_64-musl', '477cf25c53e438b5293610faadf4b932009973c08e8be3a283afa25189aa85da'),
	'linux-aarch64-glibc': makeAsset('linux-aarch64-glibc', '46873008eae6b7eb586aa56ce8787bdb8c1eccb52faf7055b32b6470c1b84cd6'),
	'linux-aarch64-musl': makeAsset('linux-aarch64-musl', '592b12257e97de01f73f681800b6f7ba43347e5880100cca4d33c6fec3eb286b'),
	'linux-armv7-glibc': makeAsset('linux-armv7-glibc', 'fae4fd7f25c8a8744f53d5b5c8cefe3bed924d9e028165eac4fef8bd6b77e51b'),
	'linux-armv7-musl': makeAsset('linux-armv7-musl', 'eb0d2ab30f849bda6c56aa098cf7512720721476a4e4449515c91d117c1454e1')
};

function detectLibc(): 'glibc' | 'musl' {
	// Alpine ships a sentinel file; other musl-based distros expose the
	// musl dynamic loader at well-known locations.
	if (existsSync('/etc/alpine-release')) return 'musl';
	for (const dir of ['/lib', '/usr/lib', '/lib64', '/usr/lib64']) {
		try {
			if (readdirSync(dir).some((f) => f.startsWith('ld-musl-'))) return 'musl';
		} catch {
			// Directory missing — not fatal, try the next.
		}
	}
	return 'glibc';
}

function detectArchKey(): string | null {
	if (process.platform !== 'linux') return null;
	const libc = detectLibc();
	let arch: string;
	switch (process.arch) {
		case 'x64': arch = 'x86_64'; break;
		case 'arm64': arch = 'aarch64'; break;
		case 'arm': arch = 'armv7'; break;
		default: return null;
	}
	return `linux-${arch}-${libc}`;
}

/**
 * Resolve the pinned asset metadata for the current platform/arch, or
 * null when this platform is not covered (macOS, Windows, exotic arches).
 */
export function resolveStaticCurlAsset(): StaticCurlAsset | null {
	const key = detectArchKey();
	if (!key) return null;
	return PINNED_ASSETS[key] ?? null;
}

export function getStaticCurlPath(): string {
	return join(getClopenDir(), 'bin', 'curl');
}

export function hasCachedStaticCurl(): boolean {
	return existsSync(getStaticCurlPath());
}

function sha256(bytes: Uint8Array): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(bytes);
	return hasher.digest('hex');
}

/**
 * Pull the `curl` binary out of a static-curl `.tar.xz` archive: unxz the
 * outer layer, then walk the tar for the entry named `curl` (it sits at the
 * archive root). The archive is small and already SHA256-verified before we
 * get here, so decoding it whole in memory is fine — no streaming needed.
 */
async function extractCurlFromArchive(archiveBytes: Uint8Array): Promise<Uint8Array | null> {
	const entries = untar(await unxz(archiveBytes));
	const curl = entries.find(
		(entry) => entry.type === 'file' && entry.name.split('/').pop() === 'curl'
	);
	return curl?.data ?? null;
}

export type CurlProgressPhase = 'cached' | 'fetching' | 'verifying' | 'extracting' | 'done';

export interface CurlProgressEvent {
	phase: CurlProgressPhase;
	message: string;
}

/**
 * Ensure curl is available for a subprocess. Returns the directory that
 * should be prepended to PATH (null when the system already has curl and
 * no action is required).
 *
 * Throws if the platform has no pinned static curl, if the download
 * fails, or if SHA256 verification fails. Never leaves a partially
 * extracted file at the final path.
 */
export async function ensureCurlAvailable(
	onProgress: (event: CurlProgressEvent) => void
): Promise<string | null> {
	if (resolveBinary('curl')) return null;

	const asset = resolveStaticCurlAsset();
	if (!asset) {
		throw new Error(`No static curl binary available for ${process.platform}/${process.arch}`);
	}

	const finalPath = getStaticCurlPath();
	const binDir = dirname(finalPath);

	if (hasCachedStaticCurl()) {
		onProgress({ phase: 'cached', message: `using cached curl at ${finalPath}` });
		return binDir;
	}

	mkdirSync(binDir, { recursive: true });

	onProgress({ phase: 'fetching', message: `downloading ${asset.url}` });
	const response = await fetch(asset.url, { redirect: 'follow' });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	const archiveBytes = new Uint8Array(await response.arrayBuffer());

	onProgress({ phase: 'verifying', message: `verifying SHA256 ${asset.sha256}` });
	const actualSha = sha256(archiveBytes);
	if (actualSha !== asset.sha256) {
		throw new Error(`SHA256 mismatch: expected ${asset.sha256}, got ${actualSha}`);
	}

	onProgress({ phase: 'extracting', message: `extracting curl to ${binDir}` });
	const curlBytes = await extractCurlFromArchive(archiveBytes);
	if (!curlBytes) {
		throw new Error('curl binary not found in archive');
	}

	// Write via a sibling tmp path then rename, so finalPath is always
	// either absent or a complete, valid binary.
	const tmpPath = `${finalPath}.tmp-${process.pid}`;
	await Bun.write(tmpPath, curlBytes);
	chmodSync(tmpPath, 0o755);
	renameSync(tmpPath, finalPath);

	onProgress({ phase: 'done', message: `curl installed at ${finalPath}` });
	debug.log('path', `static-curl: installed ${asset.archKey} v${asset.version} at ${finalPath}`);
	return binDir;
}
