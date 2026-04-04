/**
 * Cloudflared Binary Manager
 *
 * Handles downloading and managing the cloudflared binary.
 * Replaces the `cloudflared` npm package for binary management.
 *
 * Binary is stored in ~/.clopen/bin/cloudflared (or .clopen-dev for dev)
 * Downloads from GitHub releases: https://github.com/cloudflare/cloudflared/releases
 */

import { existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { platform, arch } from 'os';
import { execSync } from 'child_process';
import { getClopenDir } from '../../utils/paths';
import { debug } from '$shared/utils/logger';

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/';

/** Platform-specific download filenames */
const LINUX_FILES: Record<string, string> = {
	arm64: 'cloudflared-linux-arm64',
	arm: 'cloudflared-linux-arm',
	x64: 'cloudflared-linux-amd64',
	ia32: 'cloudflared-linux-386'
};

const MACOS_FILES: Record<string, string> = {
	arm64: 'cloudflared-darwin-arm64.tgz',
	x64: 'cloudflared-darwin-amd64.tgz'
};

const WINDOWS_FILES: Record<string, string> = {
	x64: 'cloudflared-windows-amd64.exe',
	ia32: 'cloudflared-windows-386.exe'
};

/** Get the path where the cloudflared binary should be stored */
export function getBinaryPath(): string {
	const binDir = join(getClopenDir(), 'bin');
	const name = platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared';
	return join(binDir, name);
}

/** Check if binary exists */
export function isBinaryInstalled(): boolean {
	return existsSync(getBinaryPath());
}

/** Download a file via HTTPS, following redirects */
function download(url: string, to: string, redirect = 0): Promise<string> {
	if (redirect > 10) {
		return Promise.reject(new Error('Too many redirects'));
	}

	const dir = dirname(to);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	return new Promise((resolve, reject) => {
		const protocol = url.startsWith('https') ? require('https') : require('http');

		const request = protocol.get(url, (res: any) => {
			const redirectCodes = [301, 302, 303, 307, 308];
			if (redirectCodes.includes(res.statusCode) && res.headers.location) {
				request.destroy();
				resolve(download(res.headers.location, to, redirect + 1));
				return;
			}

			if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
				const file = createWriteStream(to);
				file.on('finish', () => file.close(() => resolve(to)));
				file.on('error', (err: Error) => {
					try { unlinkSync(to); } catch { /* ignore */ }
					reject(err);
				});
				res.pipe(file);
			} else {
				request.destroy();
				reject(new Error(`HTTP ${res.statusCode} downloading cloudflared`));
			}
		});

		request.on('error', (err: Error) => reject(err));
		request.end();
	});
}

/** Get the download URL for current platform/arch */
function getDownloadUrl(version = 'latest'): string {
	const base = version === 'latest'
		? `${RELEASE_BASE}latest/download/`
		: `${RELEASE_BASE}download/${version}/`;

	const os = platform();
	const a = arch();

	if (os === 'linux') {
		const file = LINUX_FILES[a];
		if (!file) throw new Error(`Unsupported Linux architecture: ${a}`);
		return base + file;
	}

	if (os === 'darwin') {
		const file = MACOS_FILES[a];
		if (!file) throw new Error(`Unsupported macOS architecture: ${a}`);
		return base + file;
	}

	if (os === 'win32') {
		const file = WINDOWS_FILES[a];
		if (!file) throw new Error(`Unsupported Windows architecture: ${a}`);
		return base + file;
	}

	throw new Error(`Unsupported platform: ${os}`);
}

/** Install cloudflared binary for the current platform */
export async function installBinary(version = 'latest'): Promise<string> {
	const binPath = getBinaryPath();
	const url = getDownloadUrl(version);
	const os = platform();

	debug.log('tunnel', `Downloading cloudflared from ${url}`);

	if (os === 'darwin') {
		// macOS: download .tgz, extract, rename
		const tgzPath = `${binPath}.tgz`;
		await download(url, tgzPath);
		execSync(`tar -xzf ${tgzPath}`, { cwd: dirname(binPath) });
		unlinkSync(tgzPath);
		// tar extracts as "cloudflared" in the same directory
		const extractedPath = join(dirname(binPath), 'cloudflared');
		if (extractedPath !== binPath && existsSync(extractedPath)) {
			renameSync(extractedPath, binPath);
		}
	} else if (os === 'linux') {
		await download(url, binPath);
		chmodSync(binPath, '755');
	} else if (os === 'win32') {
		await download(url, binPath);
	}

	if (!existsSync(binPath)) {
		throw new Error('Binary was not created after installation');
	}

	debug.log('tunnel', `Cloudflared binary installed at: ${binPath}`);
	return binPath;
}
