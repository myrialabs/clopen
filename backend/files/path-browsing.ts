import { join, extname } from 'path';
import { readdir as fsReaddir } from 'node:fs/promises';
import { existsSync } from 'fs';

import { debug } from '$shared/utils/logger';

// Cross-platform readdir using fs.promises
async function readdir(path: string): Promise<string[]> {
	const entries = await fsReaddir(path, { withFileTypes: true });
	return entries.map(e => e.name);
}

async function statIfExists(path: string): Promise<Awaited<ReturnType<ReturnType<typeof Bun.file>['stat']>> | null> {
	try {
		return await Bun.file(path).stat();
	} catch {
		return null;
	}
}

// Returns true when every visible entry is a .app bundle or the "Applications" alias —
// the signature of a DMG/installer mount, not a general-purpose volume.
async function isLikelyMacAppVolume(volumePath: string): Promise<boolean> {
	try {
		const entries = await readdir(volumePath);
		const visible = entries.filter(e => !e.startsWith('.'));
		if (visible.length === 0) return false;
		return visible.every(e => e.endsWith('.app') || e === 'Applications');
	} catch {
		return false;
	}
}

// Return types
export interface PathBrowseData {
	name: string;
	type: 'file' | 'directory' | 'drive';
	path: string;
	modified: string;
	size?: number;
	extension?: string;
	children?: Array<{
		name: string;
		type: 'file' | 'directory';
		path: string;
		modified: string;
		kind?: 'home' | 'root' | 'volume' | 'drive';
		size?: number;
		extension?: string;
	}>;
	error?: string;
}

// Helper function to handle path-based browsing
export async function handlePathBrowsing(path: string): Promise<PathBrowseData> {
	let targetPath: string;

	// Handle special paths
	if (path === 'home') {
		// Get user's home directory
		targetPath = process.env.HOME || process.env.USERPROFILE || process.cwd();
	} else if (path === '.' || path === '') {
		// Current working directory
		targetPath = process.cwd();
	} else if (path === 'drives') {
		// List available drives/mount points for all platforms
		if (process.platform === 'win32') {
			return await handleWindowsDrives();
		} else {
			return await handleUnixMountPoints();
		}
	} else {
		// Use the provided path
		targetPath = path;
	}

	// Windows: a bare drive letter ("C:") is drive-relative — it points at the
	// drive's *current* directory, not its root. Path normalization (resolve /
	// realpath) and manual entry can both strip the trailing separator, which
	// then makes join() produce drive-relative child paths like "C:Users" whose
	// stat() fails, leaving the listing empty. Append the separator so we always
	// browse the drive root.
	if (/^[A-Za-z]:$/.test(targetPath)) {
		targetPath += '\\';
	}

	// Check if path exists (use stat instead of exists for directories)
	const file = Bun.file(targetPath);
	const stats = await file.stat();

	if (stats.isFile()) {
		// If it's a file, return file info
		return {
			name: targetPath.split(/[/\\]/).pop() || targetPath,
			type: 'file',
			path: targetPath,
			size: stats.size,
			modified: stats.mtime.toISOString(),
			extension: extname(targetPath)
		};
	}

	if (stats.isDirectory()) {
		// If it's a directory, return directory with children
		let items: string[] = [];
		try {
			items = await readdir(targetPath);
		} catch (error) {
			// Handle permission denied or other errors
			return {
				name: targetPath.split(/[/\\]/).pop() || targetPath,
				type: 'directory',
				path: targetPath,
				children: [],
				modified: stats.mtime.toISOString(),
				error: 'Permission denied or unable to read directory'
			};
		}

		const children: Array<{
			name: string;
			type: 'file' | 'directory';
			path: string;
			modified: string;
			size?: number;
			extension?: string;
		}> = [];

		for (const item of items.slice(0, 500)) { // Increased limit for better browsing
			try {
				// On Windows, skip system files BEFORE trying to stat them to prevent EBUSY errors
				if (process.platform === 'win32') {
					const skipWindows = [
						'System Volume Information', '$Recycle.Bin', 'Recovery',
						'hiberfil.sys', 'pagefile.sys', 'swapfile.sys', 'DumpStack.log.tmp',
						'bootmgr', 'BOOTNXT', 'CONFIG.SYS', 'IO.SYS', 'MSDOS.SYS',
						'NTDETECT.COM', 'NTLDR', 'boot.ini'
					];
					if (skipWindows.includes(item)) {
						continue;
					}
					// Also skip .tmp files in system directories to prevent EBUSY errors
					if (item.toLowerCase().endsWith('.tmp') && (targetPath === 'C:\\' || targetPath.match(/^[A-Z]:\\$/))) {
						continue;
					}
				}

				const itemPath = join(targetPath, item);
				const itemFile = Bun.file(itemPath);
				const itemStats = await itemFile.stat();

				children.push({
					name: item,
					type: itemStats.isDirectory() ? 'directory' : 'file',
					path: itemPath,
					modified: itemStats.mtime.toISOString(),
					...(itemStats.isFile() ? {
						size: itemStats.size,
						extension: extname(item)
					} : {})
				});
			} catch (error) {
				// Skip items we can't access (common on Windows system files)
				debug.debug('file', `Cannot access ${item}:`, error);
			}
		}

		// Sort: directories first, then files, both alphabetically
		children.sort((a, b) => {
			if (a.type !== b.type) {
				return a.type === 'directory' ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});

		return {
			name: targetPath.split(/[/\\]/).pop() || targetPath,
			type: 'directory',
			path: targetPath,
			children,
			modified: stats.mtime.toISOString()
		};
	}

	throw new Error('Path is neither a file nor a directory');
}

// Helper function to handle Unix mount points listing (Linux, macOS, etc.)
export async function handleUnixMountPoints(): Promise<PathBrowseData> {
	const items: Array<{
		name: string;
		type: 'file' | 'directory';
		path: string;
		modified: string;
		kind: 'home' | 'root' | 'volume';
	}> = [];

	// Home directory — all Unix platforms
	const homeDir = process.env.HOME;
	if (homeDir) {
		const stats = await statIfExists(homeDir);
		if (stats?.isDirectory()) {
			items.push({ name: 'Home Directory', type: 'directory', path: homeDir, modified: stats.mtime.toISOString(), kind: 'home' });
		}
	}

	if (process.platform === 'darwin') {
		// macOS: enumerate /Volumes/* — skip installer/DMG mounts
		const volumesStats = await statIfExists('/Volumes');
		if (volumesStats?.isDirectory()) {
			try {
				const volumeNames = await readdir('/Volumes');
				for (const name of volumeNames) {
					const vPath = `/Volumes/${name}`;
					try {
						const vStats = await statIfExists(vPath);
						if (!vStats?.isDirectory()) continue;
						if (await isLikelyMacAppVolume(vPath)) continue;
						items.push({ name, type: 'directory', path: vPath, modified: vStats.mtime.toISOString(), kind: 'volume' });
					} catch {
						// Skip inaccessible volumes
					}
				}
			} catch {
				// Skip if /Volumes is unreadable
			}
		}
	} else if (process.platform === 'linux') {
		// Linux: root + /mnt/*, /media/*, /run/media/{user}/* (systemd automount)
		const rootStats = await statIfExists('/');
		if (rootStats?.isDirectory()) {
			items.push({ name: 'Root (/) Filesystem', type: 'directory', path: '/', modified: rootStats.mtime.toISOString(), kind: 'root' });
		}

		for (const base of ['/mnt', '/media']) {
			const baseStats = await statIfExists(base);
			if (!baseStats?.isDirectory()) continue;
			try {
				const entries = await readdir(base);
				for (const entry of entries) {
					const entryPath = `${base}/${entry}`;
					try {
						const entryStats = await statIfExists(entryPath);
						if (entryStats?.isDirectory()) {
							items.push({ name: entry, type: 'directory', path: entryPath, modified: entryStats.mtime.toISOString(), kind: 'volume' });
						}
					} catch {
						// Skip inaccessible mounts
					}
				}
			} catch {
				// Skip if base is unreadable
			}
		}

		// systemd automount: /run/media/{user}/{volume}
		const runMediaStats = await statIfExists('/run/media');
		if (runMediaStats?.isDirectory()) {
			try {
				const users = await readdir('/run/media');
				for (const user of users) {
					const userPath = `/run/media/${user}`;
					try {
						const userStats = await statIfExists(userPath);
						if (!userStats?.isDirectory()) continue;
						const volumes = await readdir(userPath);
						for (const vol of volumes) {
							const volPath = `${userPath}/${vol}`;
							try {
								const volStats = await statIfExists(volPath);
								if (volStats?.isDirectory()) {
									items.push({ name: vol, type: 'directory', path: volPath, modified: volStats.mtime.toISOString(), kind: 'volume' });
								}
							} catch {
								// Skip inaccessible
							}
						}
					} catch {
						// Skip inaccessible user dir
					}
				}
			} catch {
				// Skip if /run/media is unreadable
			}
		}
	} else {
		// Other Unix (FreeBSD, OpenBSD, etc.): root + /mnt and /media subdirectories
		const rootStats = await statIfExists('/');
		if (rootStats?.isDirectory()) {
			items.push({ name: 'Root (/) Filesystem', type: 'directory', path: '/', modified: rootStats.mtime.toISOString(), kind: 'root' });
		}

		for (const base of ['/mnt', '/media']) {
			const baseStats = await statIfExists(base);
			if (!baseStats?.isDirectory()) continue;
			try {
				const entries = await readdir(base);
				for (const entry of entries) {
					const entryPath = `${base}/${entry}`;
					try {
						const entryStats = await statIfExists(entryPath);
						if (entryStats?.isDirectory()) {
							items.push({ name: entry, type: 'directory', path: entryPath, modified: entryStats.mtime.toISOString(), kind: 'volume' });
						}
					} catch {
						// Skip inaccessible
					}
				}
			} catch {
				// Skip if base is unreadable
			}
		}
	}

	// Deduplicate by path
	const seen = new Set<string>();
	const uniqueMounts = items.filter(item => {
		if (seen.has(item.path)) return false;
		seen.add(item.path);
		return true;
	});

	return {
		name: 'System',
		type: 'directory',
		path: 'drives',
		children: uniqueMounts,
		modified: new Date().toISOString()
	};
}

// Helper function to handle Windows drives listing
export async function handleWindowsDrives(): Promise<PathBrowseData> {
	if (process.platform !== 'win32') {
		throw new Error('Drive listing is only available on Windows');
	}

	const drives: Array<{
		name: string;
		type: 'file' | 'directory';
		path: string;
		modified: string;
		kind: 'drive';
		size?: number;
		extension?: string;
	}> = [];

	// Get list of available drives using wmic with simple output format
	const proc = Bun.spawn(['wmic', 'logicaldisk', 'get', 'caption'], {
		stdout: 'pipe',
		stderr: 'ignore'
	});
	const stdout = await new Response(proc.stdout).text();

	const lines = stdout.split('\n')
		.map(line => line.trim())
		.filter(line => line && line !== 'Caption' && line.match(/^[A-Z]:$/));

	for (const drive of lines) {
		// wmic already validated that these drives exist
		// Just add them directly without further validation
		const drivePath = drive + '\\';
		drives.push({
			name: `${drive} Drive`,
			type: 'directory',
			path: drivePath,
			modified: new Date().toISOString(),
			kind: 'drive'
		});
	}

	if (drives.length === 0) {
		for (let code = 65; code <= 90; code++) {
			const drive = String.fromCharCode(code) + ':';
			const drivePath = drive + '\\';
			try {
				if (existsSync(drivePath)) {
					drives.push({
						name: `${drive} Drive`,
						type: 'directory',
						path: drivePath,
						modified: new Date().toISOString(),
						kind: 'drive'
					});
				}
			} catch {
				// Skip unavailable drives.
			}
		}
	}

	// If no drives found, throw error
	if (drives.length === 0) {
		throw new Error('Unable to list drives');
	}

	return {
		name: 'Computer',
		type: 'directory' as const,
		path: 'drives',
		children: drives,
		modified: new Date().toISOString()
	};
}
