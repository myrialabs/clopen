import { join, extname } from 'path';

import { debug } from '$shared/utils/logger';

// Bun-compatible readdir implementation (cross-platform)
async function readdir(path: string): Promise<string[]> {
	let proc;
	if (process.platform === 'win32') {
		proc = Bun.spawn(['cmd', '/c', 'dir', '/b', path], { stdout: 'pipe', stderr: 'ignore' });
	} else {
		proc = Bun.spawn(['ls', '-1', path], { stdout: 'pipe', stderr: 'ignore' });
	}
	const result = await new Response(proc.stdout).text();
	// Split and clean up, removing \r characters for Windows compatibility
	return result.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
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
	const commonMountPoints: Array<{
		name: string;
		type: 'file' | 'directory';
		path: string;
		modified: string;
		size?: number;
		extension?: string;
	}> = [];

	// Always add root filesystem
	const rootFile = Bun.file('/');
	if (await rootFile.exists()) {
		const stats = await rootFile.stat();
		commonMountPoints.push({
			name: 'Root (/) Filesystem',
			type: 'directory',
			path: '/',
			modified: stats.mtime.toISOString()
		});
	}

	// Add user home directory
	const homeDir = process.env.HOME;
	if (homeDir) {
		const homeFile = Bun.file(homeDir);
		if (await homeFile.exists()) {
			const stats = await homeFile.stat();
			commonMountPoints.push({
				name: 'Home Directory',
				type: 'directory',
				path: homeDir,
				modified: stats.mtime.toISOString()
			});
		}
	}

	// Common mount points to check
	const potentialMounts = [
		'/mnt',       // Linux mount point
		'/media',     // Linux removable media
		'/Volumes',   // macOS mount point
		'/usr',       // Unix system directory
		'/var',       // Unix variable directory
		'/opt',       // Optional software
		'/tmp'        // Temporary directory
	];

	for (const mountPath of potentialMounts) {
		try {
			const mountFile = Bun.file(mountPath);
			if (await mountFile.exists()) {
				const stats = await mountFile.stat();
				if (stats.isDirectory()) {
					let displayName = mountPath;

					// Special names for common directories
					switch (mountPath) {
						case '/mnt':
							displayName = 'Mount Points (/mnt)';
							break;
						case '/media':
							displayName = 'Media (/media)';
							break;
						case '/Volumes':
							displayName = 'Volumes (/Volumes)';
							break;
						case '/usr':
							displayName = 'System (/usr)';
							break;
						case '/var':
							displayName = 'Variable (/var)';
							break;
						case '/opt':
							displayName = 'Optional (/opt)';
							break;
						case '/tmp':
							displayName = 'Temporary (/tmp)';
							break;
					}

					commonMountPoints.push({
						name: displayName,
						type: 'directory',
						path: mountPath,
						modified: stats.mtime.toISOString()
					});
				}
			}
		} catch {
			// Skip inaccessible mount points
		}
	}

	// On macOS, try to get mounted volumes from /Volumes
	const volumesFile = Bun.file('/Volumes');
	if (process.platform === 'darwin' && await volumesFile.exists()) {
		try {
			const volumeItems = await readdir('/Volumes');
			for (const volume of volumeItems) {
				const volumePath = `/Volumes/${volume}`;
				try {
					const volumeFile = Bun.file(volumePath);
					if (await volumeFile.exists()) {
						const stats = await volumeFile.stat();
						if (stats.isDirectory()) {
							commonMountPoints.push({
								name: `${volume} Volume`,
								type: 'directory',
								path: volumePath,
								modified: stats.mtime.toISOString()
							});
						}
					}
				} catch {
					// Skip inaccessible volumes
				}
			}
		} catch {
			// Skip if can't read /Volumes
		}
	}

	// On Linux, try to get mounted filesystems from /mnt and /media
	if (process.platform === 'linux') {
		for (const baseMount of ['/mnt', '/media']) {
			const baseMountFile = Bun.file(baseMount);
			if (await baseMountFile.exists()) {
				try {
					const mountItems = await readdir(baseMount);
					for (const mount of mountItems) {
						const mountPath = `${baseMount}/${mount}`;
						try {
							const mountFile = Bun.file(mountPath);
							if (await mountFile.exists()) {
								const stats = await mountFile.stat();
								if (stats.isDirectory()) {
									commonMountPoints.push({
										name: `${mount} (${baseMount})`,
										type: 'directory',
										path: mountPath,
										modified: stats.mtime.toISOString()
									});
								}
							}
						} catch {
							// Skip inaccessible mounts
						}
					}
				} catch {
					// Skip if can't read mount directory
				}
			}
		}
	}

	// Remove duplicates based on path
	const uniqueMounts = commonMountPoints.filter((mount, index, self) =>
		index === self.findIndex(m => m.path === mount.path)
	);

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
			modified: new Date().toISOString() // Use current time for drives
		});
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
