/**
 * ssh-client — SFTP browsing types.
 */

export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SftpEntry {
	name: string;
	/** Absolute POSIX path on the remote host. */
	path: string;
	type: SftpEntryType;
	size: number;
	/** Unix mode bits, e.g. 0o644. */
	mode: number;
	/** `rwxr-xr-x` rendering of `mode`, built server-side so every view agrees. */
	permissions: string;
	uid: number;
	gid: number;
	/** Modification time, ISO 8601. */
	modifiedAt: string;
	/** For symlinks: what the link resolves to, and the type of the target. */
	linkTarget: string | null;
	targetType: SftpEntryType | null;
}

export interface SftpListing {
	path: string;
	entries: SftpEntry[];
}

export interface SftpFileContent {
	path: string;
	/** Decoded UTF-8 text. Only returned when the file is text and small enough. */
	text: string;
	size: number;
	/** True when the file was truncated to the read limit. */
	truncated: boolean;
}

/**
 * Where a disk figure came from. It matters: on shared hosting the filesystem
 * has hundreds of free gigabytes while the account is capped at a few, so
 * labelling the number is the difference between useful and misleading.
 */
export type SftpUsageSource = 'account-quota' | 'user-quota' | 'filesystem' | 'unknown';

export interface SftpDiskUsage {
	path: string;
	totalBytes: number | null;
	usedBytes: number | null;
	availableBytes: number | null;
	source: SftpUsageSource;
	/** Human label for the source, e.g. "Account quota" or "Filesystem". */
	sourceLabel: string;
	/** Inodes (files) used and allowed, when the source reports them. */
	inodesUsed: number | null;
	inodeLimit: number | null;
}

/** What an archive is written as. */
export type SftpArchiveFormat = 'zip' | 'tar.gz';

/**
 * What to do when the name an item would take at its destination is already
 * used. `skip` leaves the existing entry alone, `overwrite` replaces it, and
 * `rename` gives the arriving item a free name — `notes (2).txt`.
 */
export type SftpConflictStrategy = 'skip' | 'overwrite' | 'rename';

/** One destination name a copy or move would land on top of. */
export interface SftpConflict {
	/** The source path that would collide. */
	path: string;
	/** The name it would take at the destination. */
	name: string;
	/** The destination path that is already occupied. */
	targetPath: string;
	/** Type of the entry already sitting there, so the prompt can name it. */
	targetType: SftpEntryType;
}

/** Outcome of an operation applied to many paths at once. */
export interface SftpBulkResult {
	succeeded: string[];
	/** Paths left untouched because something was already there. */
	skipped: string[];
	/** Paths that landed under a free name instead of the one they asked for. */
	renamed: Array<{ path: string; toPath: string }>;
	failed: Array<{ path: string; error: string }>;
}

/** Where an archive was actually written. */
export interface SftpCompressResult {
	/** The archive's path — not necessarily the requested one, if it was taken. */
	archivePath: string;
	/** True when the requested name was in use and a free one was found. */
	renamed: boolean;
}

/**
 * Where an archive's contents land. `here` unpacks into the current directory,
 * `folder` wraps them in a new one, and `smart` picks between the two by what
 * the archive actually holds — wrapping only archives that would otherwise
 * scatter loose files across the directory.
 */
export type SftpExtractMode = 'smart' | 'here' | 'folder';

/** What an archive would create, read before extracting so the user can choose. */
export interface SftpArchiveInfo {
	path: string;
	/** Names the archive would create in the destination, top level only. */
	topLevelNames: string[];
	/** True when the archive holds more entries than the listing read. */
	truncated: boolean;
	/** Wrapper folder name to offer: the archive's name without its suffix. */
	suggestedFolderName: string;
	/** Top-level names that are already taken in the destination directory. */
	conflictingNames: string[];
	/** What `smart` resolves to for this archive. */
	smartMode: 'here' | 'folder';
}

/** How an archive is unpacked. */
export interface SftpExtractOptions {
	mode: SftpExtractMode;
	/** Wrapper folder name for `folder` mode. Defaults to the archive's stem. */
	folderName?: string;
	/**
	 * Applied to the wrapper folder in `folder` mode and to the individual files
	 * in `here` mode, where `rename` has no meaning and is refused — tar and
	 * unzip can keep or replace what is there, but cannot rename around it.
	 */
	onConflict: SftpConflictStrategy;
}

export interface SftpExtractResult {
	/** The directory the contents actually landed in. */
	destination: string;
	/** True when a wrapper folder was created for them. */
	createdFolder: boolean;
}
