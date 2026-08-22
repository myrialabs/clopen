/**
 * ssh-client — remote file operations over SFTP.
 *
 * Every call leases the host's shared ssh2 client (see client-pool) and opens
 * an SFTP subsystem on it, so browsing files costs a channel rather than a
 * second handshake. Paths are remote POSIX paths and are always resolved
 * against the server's `realpath`, never joined on the Clopen host — a Windows
 * Clopen must not turn `/var/log` into `\var\log`.
 */

import { Readable, Writable } from 'node:stream';
import type { Client as SshClient, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import { sshClientPool } from './client-pool';
import { runCommandOrThrow, shellQuote } from './connect';
import { readDiskUsage } from './disk-usage';
import type {
	SftpArchiveFormat,
	SftpArchiveInfo,
	SftpBulkResult,
	SftpCompressResult,
	SftpConflict,
	SftpConflictStrategy,
	SftpDiskUsage,
	SftpEntry,
	SftpEntryType,
	SftpExtractOptions,
	SftpExtractResult,
	SftpFileContent,
	SftpListing
} from '$shared/types/ssh';
import { debug } from '$shared/utils/logger';

/** Largest file the inline text editor will open. Bigger files must be downloaded. */
export const SFTP_TEXT_READ_LIMIT = 2 * 1024 * 1024;

/** Refuse to recurse past this depth when deleting a directory tree. */
const MAX_DELETE_DEPTH = 64;

/** How many `name (2)`, `name (3)`… candidates to try before giving up. */
const MAX_RENAME_ATTEMPTS = 500;

/** How many archive entries to read when previewing what an archive holds. */
const ARCHIVE_LIST_LIMIT = 2000;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function openSftp(client: SshClient): Promise<SFTPWrapper> {
	return new Promise((resolvePromise, rejectPromise) => {
		client.sftp((error, sftp) => {
			if (error) {
				rejectPromise(new Error(`Could not open SFTP: ${error.message}`));
				return;
			}
			resolvePromise(sftp);
		});
	});
}

/** Lease the host, open SFTP, run `operation`, then close the subsystem. */
async function withSftp<T>(connectionId: string, operation: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
	return sshClientPool.use(connectionId, async (client) => {
		const sftp = await openSftp(client);
		try {
			return await operation(sftp);
		} finally {
			sftp.end();
		}
	});
}

/** Promisify one ssh2 SFTP call, whose callbacks are all `(err, value?)`. */
function callSftp<T>(
	run: (done: (error: Error | null | undefined, value?: T) => void) => void
): Promise<T> {
	return new Promise((resolvePromise, rejectPromise) => {
		run((error, value) => {
			if (error) {
				rejectPromise(error);
				return;
			}
			resolvePromise(value as T);
		});
	});
}

function typeFromMode(mode: number): SftpEntryType {
	switch (mode & S_IFMT) {
		case S_IFDIR:
			return 'directory';
		case S_IFLNK:
			return 'symlink';
		case S_IFREG:
			return 'file';
		default:
			return 'other';
	}
}

/** Render mode bits the way `ls -l` does, minus the leading type character. */
function permissionString(mode: number): string {
	const bits = ['r', 'w', 'x'];
	let rendered = '';
	for (let group = 0; group < 3; group++) {
		for (let bit = 0; bit < 3; bit++) {
			const mask = 1 << (8 - (group * 3 + bit));
			rendered += mode & mask ? bits[bit] : '-';
		}
	}
	// setuid / setgid / sticky replace the matching execute slot, as in ls.
	if (mode & 0o4000) rendered = `${rendered.slice(0, 2)}${mode & 0o100 ? 's' : 'S'}${rendered.slice(3)}`;
	if (mode & 0o2000) rendered = `${rendered.slice(0, 5)}${mode & 0o010 ? 's' : 'S'}${rendered.slice(6)}`;
	if (mode & 0o1000) rendered = `${rendered.slice(0, 8)}${mode & 0o001 ? 't' : 'T'}`;
	return rendered;
}

function toIsoTime(seconds: number): string {
	// SFTP reports seconds; a host with a broken clock can report 0 or garbage.
	const millis = seconds > 0 ? seconds * 1000 : 0;
	const date = new Date(millis);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/** Join a remote POSIX directory and child name. `..` resolves one level up. */
export function joinRemote(directory: string, name: string): string {
	if (name.startsWith('/')) return normalizeRemote(name);
	const base = directory.endsWith('/') ? directory.slice(0, -1) : directory;
	return normalizeRemote(`${base}/${name}`);
}

/** Collapse `.`, `..` and duplicate slashes in a remote POSIX path. */
export function normalizeRemote(path: string): string {
	const isAbsolute = path.startsWith('/');
	const parts: string[] = [];
	for (const segment of path.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') {
			if (parts.length > 0 && parts[parts.length - 1] !== '..') {
				parts.pop();
			} else if (!isAbsolute) {
				parts.push('..');
			}
			continue;
		}
		parts.push(segment);
	}
	const joined = parts.join('/');
	if (isAbsolute) return `/${joined}`;
	return joined || '.';
}

export function parentOfRemote(path: string): string {
	const normalized = normalizeRemote(path);
	if (normalized === '/') return '/';
	const cut = normalized.lastIndexOf('/');
	if (cut <= 0) return '/';
	return normalized.slice(0, cut);
}

/**
 * Describe one directory entry. Symlinks are reported as symlinks but also
 * carry where they point and what type the target is, so the browser can let
 * the user step into a linked directory.
 */
async function describeEntry(
	sftp: SFTPWrapper,
	directory: string,
	item: FileEntryWithStats
): Promise<SftpEntry> {
	const path = joinRemote(directory, item.filename);
	const attrs = item.attrs;
	const type = typeFromMode(attrs.mode);

	let linkTarget: string | null = null;
	let targetType: SftpEntryType | null = null;
	if (type === 'symlink') {
		try {
			linkTarget = await callSftp<string>((done) => sftp.readlink(path, done));
		} catch {
			linkTarget = null;
		}
		try {
			const targetStats = await callSftp<Stats>((done) => sftp.stat(path, done));
			targetType = typeFromMode(targetStats.mode);
		} catch {
			// A dangling symlink — leave the target type unknown.
			targetType = null;
		}
	}

	return {
		name: item.filename,
		path,
		type,
		size: attrs.size,
		mode: attrs.mode & 0o7777,
		permissions: permissionString(attrs.mode),
		uid: attrs.uid,
		gid: attrs.gid,
		modifiedAt: toIsoTime(attrs.mtime),
		linkTarget,
		targetType
	};
}

/**
 * The shell command that archives `paths` into `archivePath`.
 *
 * Both tools are run from the items' common parent so the archive stores plain
 * names — extracting it recreates `subject/`, not `home/user/subject/`.
 *
 * A name starting with `-` would otherwise be read as an option. tar accepts
 * `--` to end its options; zip does not ("can't use -- before archive name"),
 * so there the names are prefixed with `./`, which zip strips back out.
 */
export function buildCompressCommand(
	paths: string[],
	archivePath: string,
	format: SftpArchiveFormat
): string {
	const parent = parentOfRemote(paths[0]);
	const bareNames = paths.map((path) => path.split('/').pop() || path);

	if (format === 'zip') {
		const names = bareNames.map((name) => shellQuote(`./${name}`)).join(' ');
		return `cd ${shellQuote(parent)} && zip -r -q ${shellQuote(archivePath)} ${names}`;
	}
	const names = bareNames.map((name) => shellQuote(name)).join(' ');
	return `cd ${shellQuote(parent)} && tar -czf ${shellQuote(archivePath)} -- ${names}`;
}

/**
 * Suffixes that name an archive, longest compound first — `.tar.gz` has to be
 * recognised before `.gz`, or `site.tar.gz` would unwrap to `site.tar`.
 */
const ARCHIVE_SUFFIXES = [
	'.tar.gz',
	'.tar.bz2',
	'.tar.xz',
	'.tgz',
	'.tbz2',
	'.txz',
	'.zip',
	'.tar',
	'.gz'
];

/**
 * Split a name into the part a `(2)` marker goes after and the extension that
 * has to stay at the end. `notes.txt` splits, `.bashrc` does not — a leading
 * dot is part of the name, not the start of a suffix — and `site.tar.gz` keeps
 * both halves of its compound suffix together.
 */
export function splitRemoteName(name: string): { stem: string; suffix: string } {
	const lowerName = name.toLowerCase();
	for (const compound of ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst']) {
		if (lowerName.endsWith(compound) && name.length > compound.length) {
			return { stem: name.slice(0, -compound.length), suffix: name.slice(-compound.length) };
		}
	}
	const cut = name.lastIndexOf('.');
	if (cut <= 0) return { stem: name, suffix: '' };
	return { stem: name.slice(0, cut), suffix: name.slice(cut) };
}

/** The nth free-name candidate for `name`: `notes.txt` → `notes (2).txt`. */
export function buildCandidateName(name: string, attempt: number): string {
	const { stem, suffix } = splitRemoteName(name);
	return `${stem} (${attempt})${suffix}`;
}

/** The name an archive suggests for a wrapper folder: its own, minus the suffix. */
export function archiveBaseName(archivePath: string): string {
	const name = archivePath.split('/').pop() || 'archive';
	const lowerName = name.toLowerCase();
	for (const suffix of ARCHIVE_SUFFIXES) {
		if (lowerName.endsWith(suffix) && name.length > suffix.length) {
			return name.slice(0, -suffix.length);
		}
	}
	return name;
}

/**
 * The shell command that unpacks `archivePath`, chosen by its suffix.
 *
 * `keepExisting` is the "don't touch what is already there" half of the
 * conflict choice. unzip has a flag for each side of it; tar only overwrites by
 * default, and the flag that makes it skip quietly (`--skip-old-files`) is GNU
 * tar's — the tar on a BSD or macOS host understands only `-k`. Trying the
 * quiet flag first and falling back covers both, and because the fallback runs
 * whenever the first attempt fails, a genuine failure still surfaces its own
 * error rather than being swallowed by the probe.
 */
export function buildExtractCommand(
	archivePath: string,
	destinationDirectory: string,
	keepExisting = false
): string {
	const lowerName = archivePath.toLowerCase();
	const archive = shellQuote(archivePath);
	const destination = shellQuote(destinationDirectory);

	const untar = (flag: string): string => {
		const base = `tar -x${flag}f ${archive} -C ${destination}`;
		if (!keepExisting) return base;
		return `${base} --skip-old-files 2>/dev/null || ${base} -k`;
	};

	if (lowerName.endsWith('.zip')) {
		return `unzip ${keepExisting ? '-n' : '-o'} -q ${archive} -d ${destination}`;
	}
	if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz')) return untar('z');
	if (lowerName.endsWith('.tar.bz2') || lowerName.endsWith('.tbz2')) return untar('j');
	if (lowerName.endsWith('.tar.xz') || lowerName.endsWith('.txz')) return untar('J');
	if (lowerName.endsWith('.tar')) return untar('');
	if (lowerName.endsWith('.gz')) {
		// A bare .gz holds one file; decompress it into the destination.
		const stem = (archivePath.split('/').pop() || 'file').replace(/\.gz$/i, '');
		const target = shellQuote(joinRemote(destinationDirectory, stem));
		const decompress = `gunzip -c ${archive} > ${target}`;
		return keepExisting ? `[ -e ${target} ] || ${decompress}` : decompress;
	}
	throw new Error('Clopen does not know how to extract that file type');
}

/**
 * The shell command that lists an archive's entries without unpacking it. The
 * output is capped: a listing is only used to work out what the archive would
 * create at the top level, and reading a million paths to learn that is waste.
 */
export function buildArchiveListCommand(archivePath: string, limit = ARCHIVE_LIST_LIMIT): string {
	const lowerName = archivePath.toLowerCase();
	const archive = shellQuote(archivePath);
	const head = `head -n ${limit}`;

	if (lowerName.endsWith('.zip')) return `unzip -Z1 ${archive} | ${head}`;
	if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz')) return `tar -tzf ${archive} | ${head}`;
	if (lowerName.endsWith('.tar.bz2') || lowerName.endsWith('.tbz2')) return `tar -tjf ${archive} | ${head}`;
	if (lowerName.endsWith('.tar.xz') || lowerName.endsWith('.txz')) return `tar -tJf ${archive} | ${head}`;
	if (lowerName.endsWith('.tar')) return `tar -tf ${archive} | ${head}`;
	if (lowerName.endsWith('.gz')) {
		// A bare .gz has no index; the one file it holds is named after itself.
		return `echo ${shellQuote(archiveBaseName(archivePath))}`;
	}
	throw new Error('Clopen does not know how to extract that file type');
}

/**
 * Reduce an archive listing to the names it would create in the destination.
 * Only the first path segment of each entry matters: `site/index.html` and
 * `site/css/app.css` both land in the same `site/`.
 */
export function parseArchiveTopLevelNames(listing: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const line of listing.split('\n')) {
		// tar writes `./site/index.html` when the archive was made from `.`.
		const entry = line.trim().replace(/^\.\//, '');
		if (!entry || entry === '.') continue;
		const top = entry.split('/')[0];
		if (!top || seen.has(top)) continue;
		seen.add(top);
		names.push(top);
	}
	return names;
}

/** Whether anything at all sits at `path` — a dangling symlink counts. */
async function existsOn(sftp: SFTPWrapper, path: string): Promise<boolean> {
	try {
		await callSftp<Stats>((done) => sftp.lstat(path, done));
		return true;
	} catch {
		return false;
	}
}

/** The first `name (n)` inside `directory` that nothing is using yet. */
async function findFreeName(sftp: SFTPWrapper, directory: string, name: string): Promise<string> {
	for (let attempt = 2; attempt <= MAX_RENAME_ATTEMPTS; attempt++) {
		const candidate = buildCandidateName(name, attempt);
		if (!(await existsOn(sftp, joinRemote(directory, candidate)))) return candidate;
	}
	throw new Error(`Could not find a free name for ${name}`);
}

/** Delete a tree over one open SFTP subsystem, refusing to follow symlinks. */
async function removeTreeOn(sftp: SFTPWrapper, path: string, depth = 0): Promise<void> {
	if (depth > MAX_DELETE_DEPTH) {
		throw new Error(`Refusing to delete deeper than ${MAX_DELETE_DEPTH} levels`);
	}
	const stats = await callSftp<Stats>((done) => sftp.lstat(path, done));
	// A symlink is removed as a link — never followed, or deleting a link to
	// /etc would delete /etc.
	if (typeFromMode(stats.mode) !== 'directory') {
		await callSftp<void>((done) => sftp.unlink(path, done));
		return;
	}
	const items = await callSftp<FileEntryWithStats[]>((done) => sftp.readdir(path, done));
	for (const item of items) {
		await removeTreeOn(sftp, joinRemote(path, item.filename), depth + 1);
	}
	await callSftp<void>((done) => sftp.rmdir(path, done));
}

/**
 * What one step of a bulk operation did: nothing special, nothing at all, or a
 * landing under a different name.
 */
type BulkOutcome = void | undefined | 'skipped' | { renamedTo: string };

/** Where one item lands, and what has to happen first. `null` means leave it. */
interface TransferPlan {
	targetPath: string;
	/** True when something is in the way and has to be deleted first. */
	replaceExisting: boolean;
	/** True when the item had to take a different name to fit. */
	renamed: boolean;
}

/**
 * Work out where `sourcePath` lands inside `destinationDirectory`, applying
 * `strategy` when the name is taken. Returns null when the item is to be left
 * alone — either the user chose to skip it, or a move would put it back exactly
 * where it already is, which is not a conflict at all.
 */
async function planTransfer(
	sftp: SFTPWrapper,
	sourcePath: string,
	destinationDirectory: string,
	strategy: SftpConflictStrategy,
	isMove: boolean
): Promise<TransferPlan | null> {
	const name = sourcePath.split('/').pop() || sourcePath;
	const targetPath = joinRemote(destinationDirectory, name);
	const isSelf = targetPath === sourcePath;

	if (isSelf && isMove) return null;
	if (!isSelf && !(await existsOn(sftp, targetPath))) {
		return { targetPath, replaceExisting: false, renamed: false };
	}

	switch (strategy) {
		case 'skip':
			return null;
		case 'rename': {
			const freeName = await findFreeName(sftp, destinationDirectory, name);
			return {
				targetPath: joinRemote(destinationDirectory, freeName),
				replaceExisting: false,
				renamed: true
			};
		}
		default:
			// Overwriting an item with itself would delete it and then copy nothing.
			if (isSelf) throw new Error('Source and destination are the same');
			return { targetPath, replaceExisting: true, renamed: false };
	}
}

export const sftpService = {
	/** The absolute path a relative path (or `.`) resolves to on the host. */
	async realpath(connectionId: string, path: string): Promise<string> {
		return withSftp(connectionId, (sftp) =>
			callSftp<string>((done) => sftp.realpath(path || '.', done))
		);
	},

	async list(connectionId: string, path: string): Promise<SftpListing> {
		return withSftp(connectionId, async (sftp) => {
			const resolved = await callSftp<string>((done) => sftp.realpath(path || '.', done));
			const items = await callSftp<FileEntryWithStats[]>((done) => sftp.readdir(resolved, done));
			const entries = await Promise.all(items.map((item) => describeEntry(sftp, resolved, item)));
			entries.sort((left, right) => {
				// Directories first, then case-insensitive by name — the ordering
				// every file browser uses, and one the client never has to redo.
				const leftIsDir = left.type === 'directory' || left.targetType === 'directory';
				const rightIsDir = right.type === 'directory' || right.targetType === 'directory';
				if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;
				return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
			});
			return { path: resolved, entries };
		});
	},

	async stat(connectionId: string, path: string): Promise<SftpEntry> {
		return withSftp(connectionId, async (sftp) => {
			const resolved = await callSftp<string>((done) => sftp.realpath(path, done));
			const stats = await callSftp<Stats>((done) => sftp.lstat(resolved, done));
			const name = resolved.split('/').pop() || resolved;
			return describeEntry(sftp, parentOfRemote(resolved), {
				filename: name,
				longname: name,
				attrs: stats
			});
		});
	},

	async makeDirectory(connectionId: string, path: string): Promise<void> {
		await withSftp(connectionId, (sftp) => callSftp<void>((done) => sftp.mkdir(path, done)));
	},

	/** Create an empty file, failing if something is already there. */
	async createFile(connectionId: string, path: string): Promise<void> {
		await withSftp(connectionId, async (sftp) => {
			// 'wx' is exclusive-create: an existing path is an error, not a truncate.
			const handle = await callSftp<Buffer>((done) => sftp.open(path, 'wx', done));
			await callSftp<void>((done) => sftp.close(handle, done));
		});
	},

	async rename(connectionId: string, fromPath: string, toPath: string): Promise<void> {
		await withSftp(connectionId, (sftp) =>
			callSftp<void>((done) => sftp.rename(fromPath, toPath, done))
		);
	},

	async chmod(connectionId: string, path: string, mode: number): Promise<void> {
		await withSftp(connectionId, (sftp) => callSftp<void>((done) => sftp.chmod(path, mode, done)));
	},

	async remove(connectionId: string, path: string, recursive: boolean): Promise<void> {
		await withSftp(connectionId, async (sftp) => {
			if (recursive) {
				await removeTreeOn(sftp, path);
				debug.log('ssh', `removed remote tree ${path}`);
				return;
			}

			const stats = await callSftp<Stats>((done) => sftp.lstat(path, done));
			if (typeFromMode(stats.mode) === 'directory') {
				await callSftp<void>((done) => sftp.rmdir(path, done));
				return;
			}
			await callSftp<void>((done) => sftp.unlink(path, done));
		});
	},

	/**
	 * Read a file as UTF-8 for the inline editor. Files above the limit are
	 * truncated rather than refused, so a large log is still previewable.
	 */
	async readText(connectionId: string, path: string): Promise<SftpFileContent> {
		return withSftp(connectionId, async (sftp) => {
			const stats = await callSftp<Stats>((done) => sftp.stat(path, done));
			if (typeFromMode(stats.mode) === 'directory') {
				throw new Error('That path is a directory');
			}

			const truncated = stats.size > SFTP_TEXT_READ_LIMIT;
			const chunks: Buffer[] = [];
			let read = 0;

			await new Promise<void>((resolvePromise, rejectPromise) => {
				const stream = sftp.createReadStream(path, { start: 0, end: SFTP_TEXT_READ_LIMIT - 1 });
				stream.on('data', (chunk: Buffer) => {
					chunks.push(chunk);
					read += chunk.length;
				});
				stream.on('error', rejectPromise);
				stream.on('close', () => resolvePromise());
			});

			return {
				path,
				text: Buffer.concat(chunks).toString('utf8'),
				size: read,
				truncated
			};
		});
	},

	async writeText(connectionId: string, path: string, text: string): Promise<void> {
		await withSftp(connectionId, async (sftp) => {
			await new Promise<void>((resolvePromise, rejectPromise) => {
				const stream = sftp.createWriteStream(path);
				stream.on('error', rejectPromise);
				stream.on('close', () => resolvePromise());
				stream.end(Buffer.from(text, 'utf8'));
			});
		});
	},

	/**
	 * Stream a remote file out. The lease is held until the returned stream ends,
	 * so the pool cannot close the transport mid-download.
	 */
	async openDownload(
		connectionId: string,
		path: string
	): Promise<{ stream: Readable; size: number; name: string }> {
		const lease = await sshClientPool.acquire(connectionId);
		try {
			const sftp = await openSftp(lease.client);
			const stats = await callSftp<Stats>((done) => sftp.stat(path, done));
			if (typeFromMode(stats.mode) === 'directory') {
				throw new Error('That path is a directory');
			}

			const stream = sftp.createReadStream(path);
			const finish = (): void => {
				sftp.end();
				lease.release();
			};
			stream.on('close', finish);
			stream.on('error', finish);

			return { stream, size: stats.size, name: path.split('/').pop() || 'download' };
		} catch (error) {
			lease.release();
			throw error;
		}
	},

	/**
	 * Stream bytes into a remote file. Resolves once the remote side has the whole
	 * body, so the HTTP route can only report success after the write landed.
	 */
	async openUpload(connectionId: string, path: string): Promise<{ stream: Writable; done: Promise<void> }> {
		const lease = await sshClientPool.acquire(connectionId);
		try {
			const sftp = await openSftp(lease.client);
			const stream = sftp.createWriteStream(path);
			const done = new Promise<void>((resolvePromise, rejectPromise) => {
				stream.on('error', (error: Error) => {
					sftp.end();
					lease.release();
					rejectPromise(error);
				});
				stream.on('close', () => {
					sftp.end();
					lease.release();
					resolvePromise();
				});
			});
			return { stream, done };
		} catch (error) {
			lease.release();
			throw error;
		}
	},

	/**
	 * How much space the account has. Not part of SFTP, so this runs commands —
	 * see disk-usage.ts for why `df` alone is the wrong answer on shared hosting.
	 */
	async diskUsage(connectionId: string, path: string): Promise<SftpDiskUsage> {
		return sshClientPool.use(connectionId, (client) => readDiskUsage(client, path));
	},

	/**
	 * Apply `operation` to every path, collecting per-path outcomes instead of
	 * stopping at the first failure — deleting twenty files should not abort
	 * because one of them is read-only, and the user needs to know which one.
	 *
	 * An operation reports what it did: nothing for a plain success, `skipped`
	 * for an item it deliberately left alone, or the name the item ended up
	 * with when a conflict pushed it onto a different one.
	 */
	async runBulk(
		paths: string[],
		operation: (path: string) => Promise<BulkOutcome>
	): Promise<SftpBulkResult> {
		const succeeded: string[] = [];
		const skipped: string[] = [];
		const renamed: Array<{ path: string; toPath: string }> = [];
		const failed: Array<{ path: string; error: string }> = [];
		for (const path of paths) {
			try {
				const outcome = await operation(path);
				if (outcome === 'skipped') {
					skipped.push(path);
					continue;
				}
				succeeded.push(path);
				if (outcome && typeof outcome === 'object') {
					renamed.push({ path, toPath: outcome.renamedTo });
				}
			} catch (error) {
				failed.push({ path, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { succeeded, skipped, renamed, failed };
	},

	async removeMany(connectionId: string, paths: string[], recursive: boolean): Promise<SftpBulkResult> {
		return this.runBulk(paths, (path) => this.remove(connectionId, path, recursive));
	},

	/**
	 * The names in `paths` that are already taken inside `destinationDirectory`.
	 * Asked before a copy or a move so the user is offered a choice instead of
	 * being told afterwards that a file they wanted was replaced — or worse, not
	 * being told at all.
	 *
	 * A move onto an item's own directory is not a conflict: it is a no-op. A
	 * copy onto it is, because duplicating in place is a real thing to want.
	 */
	async findConflicts(
		connectionId: string,
		paths: string[],
		destinationDirectory: string,
		operation: 'move' | 'copy'
	): Promise<SftpConflict[]> {
		return withSftp(connectionId, async (sftp) => {
			const destination = await callSftp<string>((done) =>
				sftp.realpath(destinationDirectory, done)
			);
			const conflicts: SftpConflict[] = [];
			for (const path of paths) {
				const name = path.split('/').pop() || path;
				const targetPath = joinRemote(destination, name);
				if (targetPath === path && operation === 'move') continue;
				try {
					const stats = await callSftp<Stats>((done) => sftp.lstat(targetPath, done));
					conflicts.push({ path, name, targetPath, targetType: typeFromMode(stats.mode) });
				} catch {
					// Nothing there — nothing to ask about.
				}
			}
			return conflicts;
		});
	},

	/**
	 * Move paths into `destinationDirectory`. SFTP rename is tried first because
	 * it needs no shell; it fails across filesystems, so `mv` is the fallback.
	 */
	async move(
		connectionId: string,
		paths: string[],
		destinationDirectory: string,
		onConflict: SftpConflictStrategy = 'skip'
	): Promise<SftpBulkResult> {
		return withSftp(connectionId, async (sftp) => {
			const destination = await callSftp<string>((done) =>
				sftp.realpath(destinationDirectory, done)
			);
			return this.runBulk(paths, async (path) => {
				const plan = await planTransfer(sftp, path, destination, onConflict, true);
				if (!plan) return 'skipped';
				// Both rename and `mv` would put the source *inside* an existing
				// directory of the same name rather than replacing it, so what is
				// in the way has to be deleted first.
				if (plan.replaceExisting) await removeTreeOn(sftp, plan.targetPath);
				try {
					await callSftp<void>((done) => sftp.rename(path, plan.targetPath, done));
				} catch {
					await sshClientPool.use(connectionId, (client) =>
						runCommandOrThrow(
							client,
							`mv -f -- ${shellQuote(path)} ${shellQuote(plan.targetPath)}`,
							`Could not move ${path}`
						)
					);
				}
				debug.log('ssh', `moved ${path} to ${plan.targetPath}`);
				return plan.renamed ? { renamedTo: plan.targetPath } : undefined;
			});
		});
	},

	/**
	 * Copy paths into `destinationDirectory`. SFTP has no copy operation at all,
	 * so this is `cp -a` — which also preserves modes and timestamps.
	 */
	async copy(
		connectionId: string,
		paths: string[],
		destinationDirectory: string,
		onConflict: SftpConflictStrategy = 'skip'
	): Promise<SftpBulkResult> {
		return withSftp(connectionId, async (sftp) => {
			const destination = await callSftp<string>((done) =>
				sftp.realpath(destinationDirectory, done)
			);
			return this.runBulk(paths, async (path) => {
				const plan = await planTransfer(sftp, path, destination, onConflict, false);
				if (!plan) return 'skipped';
				// `cp -a src dir` copies *into* dir when dir exists, so an item being
				// replaced is removed first — otherwise "overwrite" would silently
				// nest the source inside its namesake.
				if (plan.replaceExisting) await removeTreeOn(sftp, plan.targetPath);
				await sshClientPool.use(connectionId, (client) =>
					runCommandOrThrow(
						client,
						`cp -a -- ${shellQuote(path)} ${shellQuote(plan.targetPath)}`,
						`Could not copy ${path}`
					)
				);
				return plan.renamed ? { renamedTo: plan.targetPath } : undefined;
			});
		});
	},

	/**
	 * Archive `paths` into `archivePath`. The archive stores plain names rather
	 * than full paths, so extracting it does not recreate `/home/user/...` — the
	 * `cd` into the common parent is what makes that true.
	 *
	 * An archive name already in use is resolved the same way a copy's is, and
	 * for the same reason: `zip` *adds to* an archive that already exists rather
	 * than replacing it, so "compress these two files" silently inherits
	 * whatever the old archive of that name held.
	 */
	async compress(
		connectionId: string,
		paths: string[],
		archivePath: string,
		format: SftpArchiveFormat,
		onConflict: SftpConflictStrategy = 'skip'
	): Promise<SftpCompressResult> {
		if (paths.length === 0) throw new Error('Nothing selected to compress');

		const requestedName = archivePath.split('/').pop() || archivePath;
		const plan = await withSftp(connectionId, async (sftp) => {
			const directory = await callSftp<string>((done) =>
				sftp.realpath(parentOfRemote(archivePath), done)
			);
			let target = joinRemote(directory, requestedName);
			let renamed = false;

			if (await existsOn(sftp, target)) {
				// Writing the archive over one of its own inputs would compress a
				// file that is being replaced as it is read.
				if (paths.includes(target) && onConflict === 'overwrite') {
					throw new Error('The archive cannot replace one of the items being compressed');
				}
				switch (onConflict) {
					case 'skip':
						throw new Error(`“${requestedName}” already exists here`);
					case 'rename': {
						const freeName = await findFreeName(sftp, directory, requestedName);
						target = joinRemote(directory, freeName);
						renamed = true;
						break;
					}
					default:
						await removeTreeOn(sftp, target);
				}
			}
			return { target, renamed };
		});

		await sshClientPool.use(connectionId, (client) =>
			runCommandOrThrow(
				client,
				buildCompressCommand(paths, plan.target, format),
				'Could not create the archive',
				10 * 60_000
			)
		);
		debug.log('ssh', `compressed ${paths.length} item(s) into ${plan.target}`);
		return { archivePath: plan.target, renamed: plan.renamed };
	},

	/**
	 * Read what an archive would create without unpacking it: the names it puts
	 * at the top level of the destination, and which of those are already taken.
	 * The extract dialog is built out of this — "one folder, extract it here" and
	 * "eleven loose files, wrap them" are different answers, and only the archive
	 * itself knows which one applies.
	 */
	async inspectArchive(
		connectionId: string,
		archivePath: string,
		destinationDirectory: string
	): Promise<SftpArchiveInfo> {
		const listing = await sshClientPool.use(connectionId, (client) =>
			runCommandOrThrow(
				client,
				buildArchiveListCommand(archivePath),
				'Could not read the archive',
				60_000
			)
		);
		const lines = listing ? listing.split('\n').length : 0;
		const topLevelNames = parseArchiveTopLevelNames(listing);
		const truncated = lines >= ARCHIVE_LIST_LIMIT;

		const destinationEntries = await this.list(connectionId, destinationDirectory);
		const existingNames = new Set(destinationEntries.entries.map((entry) => entry.name));

		return {
			path: archivePath,
			topLevelNames,
			truncated,
			suggestedFolderName: archiveBaseName(archivePath),
			conflictingNames: topLevelNames.filter((name) => existingNames.has(name)),
			// A single top-level entry already contains itself; wrapping it would
			// only add a directory the user has to click through. Anything else —
			// including a listing too long to be sure about — is wrapped.
			smartMode: topLevelNames.length === 1 && !truncated ? 'here' : 'folder'
		};
	},

	/**
	 * Extract an archive, either straight into `destinationDirectory` or into a
	 * folder of its own. The tool is picked by suffix; what happens to names
	 * already in use is the caller's choice.
	 */
	async extract(
		connectionId: string,
		archivePath: string,
		destinationDirectory: string,
		options: SftpExtractOptions = { mode: 'smart', onConflict: 'rename' }
	): Promise<SftpExtractResult> {
		const strategy = options.onConflict;
		let mode = options.mode;
		if (mode === 'smart') {
			const info = await this.inspectArchive(connectionId, archivePath, destinationDirectory);
			mode = info.smartMode;
		}

		let destination = destinationDirectory;
		let createdFolder = false;

		if (mode === 'folder') {
			const requestedName = (options.folderName || '').trim() || archiveBaseName(archivePath);
			if (requestedName.includes('/')) {
				throw new Error('A folder name cannot contain a slash');
			}
			destination = await withSftp(connectionId, async (sftp) => {
				const parent = await callSftp<string>((done) =>
					sftp.realpath(destinationDirectory, done)
				);
				let folderName = requestedName;
				if (await existsOn(sftp, joinRemote(parent, folderName))) {
					if (strategy === 'skip') {
						throw new Error(`“${folderName}” already exists here`);
					}
					if (strategy === 'rename') {
						folderName = await findFreeName(sftp, parent, folderName);
					}
					// Overwrite unpacks into the folder that is already there rather
					// than deleting it, so an interrupted extract cannot take the
					// user's directory with it.
				}
				const target = joinRemote(parent, folderName);
				if (!(await existsOn(sftp, target))) {
					await callSftp<void>((done) => sftp.mkdir(target, done));
					createdFolder = true;
				}
				return target;
			});
		} else if (strategy === 'rename') {
			// Nothing to rename around: unpacking into a directory that is already
			// populated merges the two, one file at a time, and neither tar nor
			// unzip can be told to sidestep a name.
			throw new Error('Extracting here can only replace or keep the existing files');
		}

		await sshClientPool.use(connectionId, (client) =>
			runCommandOrThrow(
				client,
				buildExtractCommand(archivePath, destination, strategy === 'skip'),
				'Could not extract the archive',
				10 * 60_000
			)
		);
		debug.log('ssh', `extracted ${archivePath} into ${destination}`);
		return { destination, createdFolder };
	}
};
