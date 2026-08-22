<!--
	Remote file browser over SFTP.

	Listing and small edits go over the WebSocket; file bytes go over
	/api/ssh/sftp/{download,upload}, which is where sustained binary transfer
	belongs (the same split the local Files panel uses).

	Rows are flex rather than a table so the clickable region can be one element
	spanning the name/size/permissions/modified cells at the row's full height —
	the highlighted band and the hit area are then the same rectangle, with no
	dead margin at its edges.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import MonacoCodeEditor from '$frontend/components/common/editor/MonacoCodeEditor.svelte';
	import MediaPreview from '$frontend/components/common/media/MediaPreview.svelte';
	import { detectLanguageFromFilename } from '$frontend/components/common/editor/monaco-languages';
	import { isBinaryFile, isPreviewableFile } from '$frontend/utils/file-type';
	import { sshClientStore } from '$frontend/stores/features/ssh-client.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { debug } from '$shared/utils/logger';
	import type {
		SftpArchiveFormat,
		SftpArchiveInfo,
		SftpBulkResult,
		SftpConflict,
		SftpConflictStrategy,
		SftpEntry,
		SftpExtractMode
	} from '$shared/types/ssh';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	/**
	 * Above this, a media file is offered as a download rather than previewed:
	 * a preview pulls the whole file into memory over SFTP, and doing that to a
	 * gigabyte of video helps nobody.
	 */
	const MEDIA_PREVIEW_LIMIT = 150 * 1024 * 1024;

	/** Suffixes the Extract action is offered for — the set the backend handles. */
	const ARCHIVE_SUFFIXES = [
		'.zip',
		'.tar.gz',
		'.tgz',
		'.tar.bz2',
		'.tbz2',
		'.tar.xz',
		'.txz',
		'.tar',
		'.gz'
	];

	/**
	 * Column widths shared by the header and every row. Name is capped rather
	 * than left to absorb the pane, which is what made it read as far too wide;
	 * the spacer after Modified takes the slack so the actions stay pinned right.
	 *
	 * Columns drop out as the pane narrows instead of being squeezed into each
	 * other — at phone width only the name and the actions survive, and size and
	 * date move under the name as a second line.
	 */
	const NAME_CELL_WIDTH = 'flex-1 min-w-0 max-w-[26rem] px-2';
	/** Header: one line. Row: two below sm, carrying the collapsed columns. */
	const NAME_CELL_HEADER = `${NAME_CELL_WIDTH} flex items-center`;
	const NAME_CELL_ROW = `${NAME_CELL_WIDTH} flex flex-col justify-center gap-0.5`;
	const SIZE_CELL = 'hidden @md:block w-24 shrink-0 px-2 text-right';
	const PERMISSIONS_CELL = 'hidden @4xl:block w-28 shrink-0 px-2';
	const MODIFIED_CELL = 'hidden @2xl:block w-44 shrink-0 px-2';

	const view = $derived(sshClientStore.getView(connectionId));
	const listing = $derived(sshClientStore.listings[connectionId] ?? null);
	const diskUsage = $derived(sshClientStore.diskUsage[connectionId] ?? null);

	let loading = $state(false);
	let listError = $state<string | null>(null);
	let searchQuery = $state('');
	let selectedPaths = $state<string[]>([]);
	/** Anchor for shift-click range selection. */
	let lastClickedPath = $state<string | null>(null);
	let busyLabel = $state<string | null>(null);

	let newFolderOpen = $state(false);
	let newFileOpen = $state(false);
	let renameTarget = $state<SftpEntry | null>(null);
	let deleteTargets = $state<SftpEntry[]>([]);
	let chmodTarget = $state<SftpEntry | null>(null);
	let chmodValue = $state('644');

	let compressOpen = $state(false);
	let compressFormat = $state<SftpArchiveFormat>('zip');
	let compressName = $state('');
	let compressConflict = $state<SftpConflictStrategy>('rename');
	/** Reported inside the dialog: a bad name must not close it to be seen. */
	let compressError = $state<string | null>(null);

	/** Destination picker for Move / Copy. */
	let transferMode = $state<'move' | 'copy' | null>(null);
	let pickerPath = $state('/');
	let pickerEntries = $state<SftpEntry[]>([]);
	let pickerLoading = $state(false);
	let pickerError = $state<string | null>(null);

	/**
	 * The "those names are taken" prompt, raised between choosing a destination
	 * and actually transferring. It carries the whole pending transfer, because
	 * the selection may well have been cleared by the time the user answers.
	 */
	let conflictPrompt = $state<{
		operation: 'move' | 'copy';
		paths: string[];
		destination: string;
		conflicts: SftpConflict[];
	} | null>(null);

	/** Extract options, filled from the archive itself before the dialog opens. */
	let extractTarget = $state<SftpEntry | null>(null);
	let extractInfo = $state<SftpArchiveInfo | null>(null);
	let extractLoading = $state(false);
	let extractMode = $state<SftpExtractMode>('smart');
	let extractFolderName = $state('');
	let extractConflict = $state<SftpConflictStrategy>('rename');

	/** Neutral counterpart to listError: what an operation did, not what failed. */
	let noticeText = $state<string | null>(null);

	let editorEntry = $state<SftpEntry | null>(null);
	/** Set when a file with no telling extension turns out to hold raw bytes. */
	let editorBinary = $state(false);
	let editorText = $state('');
	let editorTruncated = $state(false);
	let editorLoading = $state(false);
	let editorSaving = $state(false);
	let editorError = $state<string | null>(null);

	let uploadInput = $state<HTMLInputElement | null>(null);
	/** The one byte-moving transfer in flight — upload or download, never both. */
	let transferProgress = $state<{
		verb: 'Uploading' | 'Downloading' | 'Opening';
		name: string;
		transferredBytes: number;
		/**
		 * The total, when it is known. It cannot be read off the transfer: Bun
		 * drops Content-Length for a streamed body and sends the response
		 * chunked, so the browser reports `lengthComputable: false` and a total
		 * of zero for every download. The size comes from the listing instead.
		 */
		totalBytes: number | null;
		/** All the bytes are in; the far side is still finishing the write. */
		settling: boolean;
	} | null>(null);
	/** Its abort handle, so a transfer that stalls never has to be waited out. */
	let transferRequest: XMLHttpRequest | null = null;
	/**
	 * Which operation owns the busy banner. A call that finishes late — one the
	 * user dismissed, or that timed out after the next action started — must not
	 * clear a label it no longer owns, and no call may hold the toolbar forever.
	 */
	let busyToken = 0;
	/** The two breadcrumb strips — one per layout; only one is mounted at a time. */
	let breadcrumbBars = $state<Array<HTMLElement | null>>([null, null]);

	const entries = $derived.by(() => {
		const all = listing?.entries ?? [];
		const query = searchQuery.trim().toLowerCase();
		if (!query) return all;
		return all.filter((entry) => entry.name.toLowerCase().includes(query));
	});

	const selectedEntries = $derived(
		(listing?.entries ?? []).filter((entry) => selectedPaths.includes(entry.path))
	);
	const allVisibleSelected = $derived(
		entries.length > 0 && entries.every((entry) => selectedPaths.includes(entry.path))
	);
	/**
	 * How a file should be opened. Extension first, the way the Files panel
	 * decides it — a video, a PDF or an image has no business being poured into
	 * a text editor, and an archive is bytes however hard you squint at it.
	 */
	function viewerKindFor(entry: SftpEntry): 'media' | 'binary' | 'oversized' | 'text' {
		if (isPreviewableFile(entry.name)) {
			return entry.size > MEDIA_PREVIEW_LIMIT ? 'oversized' : 'media';
		}
		if (isBinaryFile(entry.name)) return 'binary';
		return 'text';
	}

	const viewerKind = $derived.by(() => {
		if (!editorEntry) return 'text';
		if (editorBinary) return 'binary';
		return viewerKindFor(editorEntry);
	});

	/** Extract only makes sense for exactly one archive, so that is when it appears. */
	const selectedArchive = $derived(
		selectedEntries.length === 1 && isArchive(selectedEntries[0]) ? selectedEntries[0] : null
	);

	/**
	 * What "smart" resolves to for the archive being extracted. The archive
	 * decides: one top-level entry is already its own folder, anything else
	 * would otherwise scatter across the current directory.
	 */
	const resolvedExtractMode = $derived(
		extractMode === 'smart' ? (extractInfo?.smartMode ?? 'folder') : extractMode
	);

	const extractModeChoices: Array<{ value: SftpExtractMode; label: string; hint: string }> = $derived(
		[
			{
				value: 'smart',
				label: 'Decide for me',
				hint: extractInfo
					? extractInfo.smartMode === 'here'
						? 'This archive already holds a single item — unpack it as it is'
						: 'This archive holds loose items — wrap them in a folder'
					: 'Unpack a self-contained archive as it is, wrap a loose one'
			},
			{
				value: 'here',
				label: 'Unpack here',
				hint: `Contents land directly in ${listing?.path ?? 'this folder'}`
			},
			{
				value: 'folder',
				label: 'Unpack into a new folder',
				hint: 'Contents land in a folder of their own'
			}
		]
	);

	/**
	 * Unpacking here merges with what is already in the directory, so the choice
	 * there is only replace-or-keep; a wrapper folder can also step aside.
	 */
	const extractConflictChoices: Array<{ value: SftpConflictStrategy; label: string }> = $derived(
		resolvedExtractMode === 'here'
			? [
					{ value: 'overwrite', label: 'Replace the existing files' },
					{ value: 'skip', label: 'Keep the existing files' }
				]
			: [
					{ value: 'rename', label: 'Use a free name, e.g. “site (2)”' },
					{ value: 'overwrite', label: 'Unpack into the folder that is there' },
					{ value: 'skip', label: 'Stop and tell me' }
				]
	);

	/** The file name the compress dialog would write, suffix included. */
	const compressFileName = $derived.by(() => {
		const baseName = compressName.trim();
		if (!baseName) return '';
		const suffix = compressFormat === 'zip' ? '.zip' : '.tar.gz';
		return baseName.endsWith(suffix) ? baseName : `${baseName}${suffix}`;
	});

	/**
	 * Whether the directory already holds that name. Answered from the listing
	 * that is already on screen, so the warning appears as the name is typed
	 * rather than after the archive has been written — the server checks again
	 * regardless, since this listing can be a few seconds stale.
	 */
	const compressNameTaken = $derived(
		compressFileName !== '' &&
			(listing?.entries ?? []).some((entry) => entry.name === compressFileName)
	);

	/** What "use a free name" would produce, shown so the choice is concrete. */
	const compressFreeNamePreview = $derived.by(() => {
		const suffix = compressFormat === 'zip' ? '.zip' : '.tar.gz';
		const baseName = compressFileName.endsWith(suffix)
			? compressFileName.slice(0, -suffix.length)
			: compressFileName;
		return `${baseName} (2)${suffix}`;
	});

	/** Top-level names in the archive that this directory already uses. */
	/** How far along the transfer is, or null when nothing knows the total. */
	const transferRatio = $derived.by(() => {
		if (!transferProgress) return null;
		if (transferProgress.settling) return 1;
		const total = transferProgress.totalBytes;
		if (!total || total <= 0) return null;
		return Math.min(1, transferProgress.transferredBytes / total);
	});

	const extractHereConflicts = $derived(
		resolvedExtractMode === 'here' ? (extractInfo?.conflictingNames ?? []) : []
	);

	/**
	 * Breadcrumb segments. The root is a segment like any other but is labelled
	 * and iconed rather than drawn as "/", because a "/" crumb sitting between
	 * "/" separators reads as punctuation instead of a place.
	 */
	const crumbs = $derived.by(() => {
		const path = listing?.path ?? '/';
		const segments = path.split('/').filter(Boolean);
		const result = [{ label: 'root', path: '/', isRoot: true }];
		let accumulated = '';
		for (const segment of segments) {
			accumulated += `/${segment}`;
			result.push({ label: segment, path: accumulated, isRoot: false });
		}
		return result;
	});

	const isAtRoot = $derived((listing?.path ?? '/') === '/');

	function parentOf(path: string): string {
		if (path === '/') return '/';
		const cut = path.lastIndexOf('/');
		return cut <= 0 ? '/' : path.slice(0, cut);
	}

	function joinPath(directory: string, name: string): string {
		return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
	}

	function isDirectory(entry: SftpEntry): boolean {
		return entry.type === 'directory' || entry.targetType === 'directory';
	}

	function isArchive(entry: SftpEntry): boolean {
		if (isDirectory(entry)) return false;
		const lowerName = entry.name.toLowerCase();
		return ARCHIVE_SUFFIXES.some((suffix) => lowerName.endsWith(suffix));
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	function formatTime(iso: string): string {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime()) || date.getTime() === 0) return '—';
		return date.toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function iconFor(entry: SftpEntry): IconName {
		if (isDirectory(entry)) return 'lucide:folder';
		if (entry.type === 'symlink') return 'lucide:link';
		if (isArchive(entry)) return 'lucide:file-archive';
		return 'lucide:file';
	}

	/** "3.7 GB of 5 GB used (74%)" — the account's real numbers, or nothing. */
	const diskSummary = $derived.by(() => {
		if (!diskUsage || diskUsage.usedBytes === null) return null;
		const used = formatBytes(diskUsage.usedBytes);
		if (diskUsage.totalBytes === null || diskUsage.totalBytes === 0) {
			return { text: `${used} used`, ratio: null, label: diskUsage.sourceLabel };
		}
		const ratio = diskUsage.usedBytes / diskUsage.totalBytes;
		return {
			text: `${used} of ${formatBytes(diskUsage.totalBytes)} used (${(ratio * 100).toFixed(1)}%)`,
			ratio,
			label: diskUsage.sourceLabel
		};
	});

	async function navigate(path: string): Promise<void> {
		loading = true;
		listError = null;
		try {
			await sshClientStore.listFiles(connectionId, path);
			selectedPaths = [];
			lastClickedPath = null;
		} catch (error) {
			listError = error instanceof Error ? error.message : 'Could not list that directory';
		} finally {
			loading = false;
		}
	}

	async function refresh(): Promise<void> {
		const path = listing?.path ?? view.currentPath ?? '';
		await navigate(path);
		try {
			await sshClientStore.loadDiskUsage(connectionId, listing?.path ?? path ?? '/');
		} catch (error) {
			// Free space is a nicety; a host that cannot report it still browses.
			debug.warn('ssh', 'Could not read remote disk usage:', error);
		}
	}

	// This component is reused across hosts, so the previous host's in-flight
	// label — and its in-flight download — must not carry over to the new one.
	$effect(() => {
		void connectionId;
		untrack(() => {
			busyToken++;
			busyLabel = null;
			cancelTransfer();
		});
	});

	// First open, host switch, and any externally requested reload land here.
	// The starting path is read untracked: listing a directory writes it back to
	// the view, and tracking it would make this effect re-run on its own result.
	$effect(() => {
		const id = connectionId;
		void sshClientStore.listingNonce;
		const startingPath = untrack(() => sshClientStore.getView(id).currentPath ?? '');
		void navigate(startingPath);
	});

	// A deep path overflows the strip. Scroll it to the end so the directory the
	// user is actually in is the one on screen.
	$effect(() => {
		void listing?.path;
		for (const bar of breadcrumbBars) {
			if (bar) bar.scrollLeft = bar.scrollWidth;
		}
	});

	$effect(() => {
		const path = listing?.path;
		if (!path) return;
		sshClientStore.loadDiskUsage(connectionId, path).catch((error) => {
			debug.warn('ssh', 'Could not read remote disk usage:', error);
		});
	});

	// ── Selection ────────────────────────────────────────────────────────

	function toggleSelection(path: string): void {
		selectedPaths = selectedPaths.includes(path)
			? selectedPaths.filter((selected) => selected !== path)
			: [...selectedPaths, path];
		lastClickedPath = path;
	}

	/** Select every row between the anchor and `path`, inclusive. */
	function selectRange(path: string): void {
		const anchorIndex = entries.findIndex((entry) => entry.path === lastClickedPath);
		const targetIndex = entries.findIndex((entry) => entry.path === path);
		if (anchorIndex === -1 || targetIndex === -1) {
			toggleSelection(path);
			return;
		}
		const [from, to] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
		const range = entries.slice(from, to + 1).map((entry) => entry.path);
		selectedPaths = [...new Set([...selectedPaths, ...range])];
	}

	function toggleSelectAll(): void {
		selectedPaths = allVisibleSelected ? [] : entries.map((entry) => entry.path);
	}

	function openEntry(entry: SftpEntry, event: MouseEvent): void {
		// Modifier clicks select instead of opening — the convention every file
		// manager uses, and what makes single-click-to-open safe alongside
		// multi-select.
		if (event.shiftKey) {
			selectRange(entry.path);
			return;
		}
		if (event.ctrlKey || event.metaKey) {
			toggleSelection(entry.path);
			return;
		}
		if (isDirectory(entry)) {
			void navigate(entry.path);
			return;
		}
		void openFile(entry);
	}

	// ── Editor ───────────────────────────────────────────────────────────

	/**
	 * Open a file in whichever view suits it. Only text is read here — a video or
	 * an archive is left to the viewer, which streams it over the transfer route
	 * instead of dragging it through a UTF-8 decode first.
	 *
	 * For text: read first, mount second. Monaco captures its model's contents
	 * when it initialises, so mounting it against an empty string and filling
	 * that string afterwards races the loader — and loses, leaving an empty
	 * editor.
	 */
	async function openFile(entry: SftpEntry): Promise<void> {
		editorEntry = entry;
		editorText = '';
		editorError = null;
		editorTruncated = false;
		editorBinary = false;
		if (viewerKindFor(entry) !== 'text') return;

		editorLoading = true;
		try {
			const content = await sshClientStore.readFile(connectionId, entry.path);
			// A file whose name promises nothing can still be a binary. A NUL byte
			// is the giveaway, and the surest way to keep one out of the editor.
			if (content.text.includes('\u0000')) {
				editorBinary = true;
				return;
			}
			editorText = content.text;
			editorTruncated = content.truncated;
		} catch (error) {
			editorError = error instanceof Error ? error.message : 'Could not read that file';
		} finally {
			editorLoading = false;
		}
	}

	async function saveEditor(): Promise<void> {
		if (!editorEntry) return;
		editorSaving = true;
		editorError = null;
		try {
			await sshClientStore.writeFile(connectionId, editorEntry.path, editorText);
			editorEntry = null;
			await refresh();
		} catch (error) {
			editorError = error instanceof Error ? error.message : 'Could not save that file';
		} finally {
			editorSaving = false;
		}
	}

	// ── Mutations ────────────────────────────────────────────────────────

	/**
	 * Run a mutation with a busy label, then re-list. The operation reports its
	 * own problem by returning a message rather than writing the banner: the
	 * re-list clears the banner, so anything set before it would be wiped.
	 */
	async function withBusy(
		label: string,
		operation: () => Promise<string | null | void>
	): Promise<void> {
		const token = ++busyToken;
		busyLabel = label;
		listError = null;
		noticeText = null;
		let problem: string | null = null;
		try {
			problem = (await operation()) ?? null;
			await refresh();
		} catch (error) {
			problem = error instanceof Error ? error.message : `${label} failed`;
		} finally {
			// Only the operation still holding the banner may take it down. A late
			// finisher clearing it would re-enable the toolbar over a live write.
			if (busyToken === token) busyLabel = null;
			if (problem) listError = problem;
		}
	}

	/**
	 * Let go of the busy banner without waiting for the operation. The remote
	 * work carries on and still refreshes the listing when it lands — this only
	 * gives the toolbar back, so a slow host can never wedge the whole panel.
	 */
	function dismissBusy(): void {
		busyToken++;
		busyLabel = null;
	}

	/** Describe the paths a bulk operation could not handle, or null if all worked. */
	function describeFailures(result: SftpBulkResult): string | null {
		if (result.failed.length === 0) return null;
		return result.failed
			.map((failure) => `${failure.path.split('/').pop()}: ${failure.error}`)
			.join('\n');
	}

	/**
	 * Describe what the conflict choice actually did. A skipped or renamed item
	 * is not a failure, but the user still has to be told — a "Copy" that
	 * quietly left half the selection behind is the bug this whole prompt exists
	 * to prevent.
	 */
	function describeOutcome(result: SftpBulkResult): string | null {
		const parts: string[] = [];
		if (result.renamed.length === 1) {
			parts.push(`1 item kept as “${result.renamed[0].toPath.split('/').pop()}”`);
		} else if (result.renamed.length > 1) {
			parts.push(`${result.renamed.length} items kept under new names`);
		}
		if (result.skipped.length > 0) {
			parts.push(`${result.skipped.length} left as ${result.skipped.length === 1 ? 'it was' : 'they were'}`);
		}
		return parts.length > 0 ? parts.join(' · ') : null;
	}

	async function createFolder(value?: string): Promise<void> {
		newFolderOpen = false;
		const name = (value ?? '').trim();
		if (!name || !listing) return;
		const directory = listing.path;
		await withBusy('Creating folder', () =>
			sshClientStore.makeDirectory(connectionId, joinPath(directory, name))
		);
	}

	async function createFile(value?: string): Promise<void> {
		newFileOpen = false;
		const name = (value ?? '').trim();
		if (!name || !listing) return;
		const directory = listing.path;
		await withBusy('Creating file', () =>
			sshClientStore.createFile(connectionId, joinPath(directory, name))
		);
	}

	async function commitRename(value?: string): Promise<void> {
		const target = renameTarget;
		renameTarget = null;
		const name = (value ?? '').trim();
		if (!target || !name || name === target.name) return;
		await withBusy('Renaming', () =>
			sshClientStore.renameFile(connectionId, target.path, joinPath(parentOf(target.path), name))
		);
	}

	async function commitDelete(): Promise<void> {
		const targets = deleteTargets;
		deleteTargets = [];
		if (targets.length === 0) return;
		await withBusy('Deleting', async () => {
			const result = await sshClientStore.deleteFiles(
				connectionId,
				targets.map((entry) => entry.path),
				true
			);
			return describeFailures(result);
		});
	}

	async function commitChmod(value?: string): Promise<void> {
		const target = chmodTarget;
		chmodTarget = null;
		const octal = (value ?? '').trim();
		if (!target) return;
		if (!/^[0-7]{3,4}$/.test(octal)) {
			listError = 'Permissions must be three or four octal digits, e.g. 644';
			return;
		}
		await withBusy('Changing permissions', () =>
			sshClientStore.chmodFile(connectionId, target.path, Number.parseInt(octal, 8))
		);
	}

	function startCompress(): void {
		const first = selectedEntries[0];
		compressName = selectedEntries.length === 1 && first ? first.name : 'archive';
		compressFormat = 'zip';
		compressConflict = 'rename';
		compressError = null;
		compressOpen = true;
	}

	async function commitCompress(): Promise<void> {
		if (!listing || selectedEntries.length === 0) return;
		const fileName = compressFileName;
		if (!fileName) {
			compressError = 'The archive needs a name';
			return;
		}
		if (fileName.includes('/')) {
			compressError = 'The archive name cannot contain a slash';
			return;
		}
		const archivePath = joinPath(listing.path, fileName);
		const paths = selectedEntries.map((entry) => entry.path);
		const format = compressFormat;
		// When nothing is in the way, `rename` still covers the gap between this
		// check and the write: an archive that appears in between is kept, and
		// `zip` in particular would otherwise add to it rather than replace it.
		const onConflict = compressNameTaken ? compressConflict : 'rename';
		compressOpen = false;

		let landedAs: string | null = null;
		await withBusy('Compressing', async () => {
			const result = await sshClientStore.compressFiles(
				connectionId,
				paths,
				archivePath,
				format,
				onConflict
			);
			landedAs = result.renamed ? result.archivePath : null;
			return null;
		});
		if (landedAs) noticeText = `Written as “${(landedAs as string).split('/').pop()}”`;
	}

	// ── Extract ──────────────────────────────────────────────────────────

	/** The archive's own name, minus its suffix — the folder it suggests. */
	function archiveStem(name: string): string {
		const lowerName = name.toLowerCase();
		const suffix = ARCHIVE_SUFFIXES.find(
			(candidate) => lowerName.endsWith(candidate) && name.length > candidate.length
		);
		return suffix ? name.slice(0, -suffix.length) : name;
	}

	/**
	 * Open the extract dialog, reading the archive first. What it holds is what
	 * makes the choice meaningful: wrapping a tarball that already contains one
	 * folder buries it, and not wrapping one with fifty loose files empties them
	 * over whatever is in the directory.
	 */
	async function openExtract(entry: SftpEntry): Promise<void> {
		extractTarget = entry;
		extractInfo = null;
		extractMode = 'smart';
		extractConflict = 'rename';
		extractFolderName = archiveStem(entry.name);
		extractLoading = true;
		listError = null;
		try {
			const info = await sshClientStore.inspectArchive(
				connectionId,
				entry.path,
				listing?.path ?? '/'
			);
			extractInfo = info;
			extractFolderName = info.suggestedFolderName;
			// The default conflict choice was picked before the archive had been
			// read. Now that "decide for me" has an answer, re-apply it: "keep
			// both" means nothing when the contents land here.
			chooseExtractMode(extractMode);
		} catch (error) {
			// A host without `unzip` cannot be previewed, but the dialog still
			// works — the extract itself will report the missing tool.
			debug.warn('ssh', 'Could not read the archive listing:', error);
		} finally {
			extractLoading = false;
		}
	}

	/**
	 * Extracting here can only replace or keep what is there, so a "keep both"
	 * choice carried over from folder mode has to give way.
	 */
	function chooseExtractMode(mode: SftpExtractMode): void {
		extractMode = mode;
		const resolved = mode === 'smart' ? (extractInfo?.smartMode ?? 'folder') : mode;
		if (resolved === 'here' && extractConflict === 'rename') extractConflict = 'overwrite';
	}

	async function commitExtract(): Promise<void> {
		const target = extractTarget;
		if (!target || !listing) return;
		const destination = listing.path;
		const options = {
			mode: extractMode,
			folderName: extractFolderName.trim() || undefined,
			onConflict: extractConflict
		};
		extractTarget = null;

		let landedIn: string | null = null;
		await withBusy('Extracting', async () => {
			const result = await sshClientStore.extractArchive(
				connectionId,
				target.path,
				destination,
				options
			);
			landedIn = result.destination === destination ? null : result.destination;
			return null;
		});
		if (landedIn) noticeText = `Extracted into “${(landedIn as string).split('/').pop()}”`;
	}

	// ── Move / copy destination picker ───────────────────────────────────

	async function loadPicker(path: string): Promise<void> {
		pickerLoading = true;
		pickerError = null;
		try {
			const result = await sshClientStore.browseFiles(connectionId, path);
			pickerPath = result.path;
			pickerEntries = result.entries.filter((entry) => isDirectory(entry));
		} catch (error) {
			pickerError = error instanceof Error ? error.message : 'Could not list that directory';
		} finally {
			pickerLoading = false;
		}
	}

	function startTransfer(mode: 'move' | 'copy'): void {
		transferMode = mode;
		pickerEntries = [];
		void loadPicker(listing?.path ?? '/');
	}

	/**
	 * Look before transferring. Everything the destination already has under one
	 * of these names is put to the user first — replacing a directory tree
	 * because two things happened to share a name is not a recoverable mistake.
	 */
	async function commitTransfer(): Promise<void> {
		const operation = transferMode;
		const destination = pickerPath;
		const paths = selectedEntries.map((entry) => entry.path);
		transferMode = null;
		if (!operation || paths.length === 0) return;

		busyLabel = 'Checking destination';
		listError = null;
		noticeText = null;
		let conflicts: SftpConflict[] = [];
		try {
			conflicts = await sshClientStore.checkTransferConflicts(
				connectionId,
				paths,
				destination,
				operation
			);
		} catch (error) {
			listError = error instanceof Error ? error.message : 'Could not read the destination';
			return;
		} finally {
			busyLabel = null;
		}

		if (conflicts.length > 0) {
			conflictPrompt = { operation, paths, destination, conflicts };
			return;
		}
		// Nothing is in the way. `rename` still guards the gap between this check
		// and the transfer: a file that appears in between is kept, not clobbered.
		await runTransfer(operation, paths, destination, 'rename');
	}

	async function runTransfer(
		operation: 'move' | 'copy',
		paths: string[],
		destination: string,
		onConflict: SftpConflictStrategy
	): Promise<void> {
		let outcome: string | null = null;
		await withBusy(operation === 'move' ? 'Moving' : 'Copying', async () => {
			const result =
				operation === 'move'
					? await sshClientStore.moveFiles(connectionId, paths, destination, onConflict)
					: await sshClientStore.copyFiles(connectionId, paths, destination, onConflict);
			outcome = describeOutcome(result);
			return describeFailures(result);
		});
		noticeText = outcome;
	}

	function resolveConflicts(strategy: SftpConflictStrategy): void {
		const prompt = conflictPrompt;
		conflictPrompt = null;
		if (!prompt) return;
		void runTransfer(prompt.operation, prompt.paths, prompt.destination, strategy);
	}

	// ── Transfer ─────────────────────────────────────────────────────────

	/** Stop whatever bytes are moving. The half-written side is the server's. */
	function cancelTransfer(): void {
		transferRequest?.abort();
		transferRequest = null;
		transferProgress = null;
	}

	/**
	 * Pull a remote file into memory over the transfer route, with progress and
	 * a cancel. Returns null when it failed or the user gave up.
	 *
	 * XHR rather than fetch: a transfer of unknown size has to be cancellable
	 * and has to show progress, and a plain `fetch(...).blob()` gives neither —
	 * which is what used to freeze the whole panel behind one big file. The
	 * blob also inherits the response's Content-Type, which is what lets a
	 * preview play the video instead of staring at octet-stream.
	 */
	async function fetchRemoteBlob(
		path: string,
		name: string,
		verb: 'Downloading' | 'Opening',
		totalBytes: number | null
	): Promise<Blob | null> {
		const token = authStore.sessionToken;
		if (!token) {
			listError = 'Not authenticated';
			return null;
		}
		const params = new URLSearchParams({ connectionId, path });
		transferProgress = { verb, name, transferredBytes: 0, totalBytes, settling: false };
		try {
			return await new Promise<Blob>((resolvePromise, rejectPromise) => {
				const request = new XMLHttpRequest();
				transferRequest = request;
				request.open('GET', `/api/ssh/sftp/download?${params.toString()}`);
				request.responseType = 'blob';
				request.setRequestHeader('Authorization', `Bearer ${token}`);
				request.onprogress = (event) => {
					// event.total is zero on a chunked response, which is every
					// download here — fall back to the size the listing reported.
					transferProgress = {
						verb,
						name,
						transferredBytes: event.loaded,
						totalBytes: event.total > 0 ? event.total : totalBytes,
						settling: false
					};
				};
				request.onload = () => {
					if (request.status >= 200 && request.status < 300) {
						resolvePromise(request.response as Blob);
						return;
					}
					// The route reports why in the body, which is a blob here like
					// any other response — read it rather than losing the reason.
					const body: unknown = request.response;
					if (body instanceof Blob) {
						body
							.text()
							.then((text) => rejectPromise(new Error(text.trim() || `HTTP ${request.status}`)))
							.catch(() => rejectPromise(new Error(`HTTP ${request.status}`)));
						return;
					}
					rejectPromise(new Error(`HTTP ${request.status}`));
				};
				request.onerror = () => rejectPromise(new Error('Network error during transfer'));
				request.onabort = () => rejectPromise(new DOMException('Transfer cancelled', 'AbortError'));
				request.send();
			});
		} catch (error) {
			if (!(error instanceof DOMException && error.name === 'AbortError')) {
				listError = error instanceof Error ? error.message : 'Transfer failed';
			}
			return null;
		} finally {
			transferRequest = null;
			transferProgress = null;
		}
	}

	/** The media viewer's source: the same bytes, kept in memory instead of saved. */
	async function loadRemoteBlob(path: string): Promise<Blob | null> {
		const openEntry = editorEntry;
		return fetchRemoteBlob(
			path,
			path.split('/').pop() || 'file',
			'Opening',
			openEntry && openEntry.path === path ? openEntry.size : null
		);
	}

	/**
	 * Fetch one file and hand it to the browser. Returns false when it failed or
	 * was cancelled, which is what stops a multi-file download after the first
	 * cancel instead of starting the next one.
	 */
	async function download(entry: SftpEntry): Promise<boolean> {
		const blob = await fetchRemoteBlob(entry.path, entry.name, 'Downloading', entry.size);
		if (!blob) return false;
		// A plain anchor cannot carry the bearer header, so the body is fetched
		// first and the browser is handed a blob URL.
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = entry.name;
		anchor.click();
		URL.revokeObjectURL(url);
		return true;
	}

	async function downloadSelected(): Promise<void> {
		// Sequential: browsers throttle and reorder parallel downloads, and each
		// one holds an SFTP channel open while it runs. This deliberately does not
		// take the busy banner — moving bytes must not disable the toolbar.
		for (const entry of selectedEntries.filter((candidate) => !isDirectory(candidate))) {
			if (!(await download(entry))) break;
		}
	}

	async function uploadFiles(files: FileList): Promise<void> {
		const token = authStore.sessionToken;
		if (!token || !listing) return;

		for (const file of Array.from(files)) {
			transferProgress = {
				verb: 'Uploading',
				name: file.name,
				transferredBytes: 0,
				totalBytes: file.size,
				settling: false
			};
			const params = new URLSearchParams({
				connectionId,
				targetPath: listing.path,
				fileName: file.name
			});
			try {
				// XHR rather than fetch: it is the only way to drive a real progress bar.
				await new Promise<void>((resolvePromise, rejectPromise) => {
					const request = new XMLHttpRequest();
					transferRequest = request;
					request.open('POST', `/api/ssh/sftp/upload?${params.toString()}`);
					request.setRequestHeader('Authorization', `Bearer ${token}`);
					request.upload.onprogress = (event) => {
						const sent = event.loaded;
						const total = event.total > 0 ? event.total : file.size;
						transferProgress = {
							verb: 'Uploading',
							name: file.name,
							transferredBytes: sent,
							totalBytes: total,
							// The bytes reaching Clopen are not the bytes reaching the
							// host: the write to the remote is still running once the
							// body is in. Saying so beats a full bar that sits there.
							settling: total > 0 && sent >= total
						};
					};
					request.onload = () => {
						if (request.status >= 200 && request.status < 300) {
							resolvePromise();
						} else {
							rejectPromise(new Error((request.responseText || '').trim() || `HTTP ${request.status}`));
						}
					};
					request.onerror = () => rejectPromise(new Error('Network error during upload'));
					request.onabort = () => rejectPromise(new DOMException('Upload cancelled', 'AbortError'));
					request.send(file);
				});
			} catch (error) {
				if (!(error instanceof DOMException && error.name === 'AbortError')) {
					listError = error instanceof Error ? error.message : 'Upload failed';
				}
				break;
			} finally {
				transferRequest = null;
			}
		}

		transferProgress = null;
		await refresh();
	}

	const toolbarButton =
		'flex items-center justify-center w-8 h-8 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
	const rowAction =
		'flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
	const bulkAction =
		'flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-40';
	const fieldClass =
		'px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100';
</script>

{#snippet breadcrumbs()}
	{#each crumbs as crumb, index (crumb.path)}
		{#if index > 0}
			<Icon
				name="lucide:chevron-right"
				class="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 shrink-0"
			/>
		{/if}
		<button
			type="button"
			class="flex items-center gap-1 text-xs px-1.5 py-1 rounded shrink-0 truncate transition-colors {index ===
			crumbs.length - 1
				? 'max-w-[240px] text-slate-900 dark:text-slate-100 font-semibold'
				: 'max-w-[140px] text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400'}"
			onclick={() => navigate(crumb.path)}
			title={crumb.isRoot ? 'Root directory' : crumb.path}
		>
			{#if crumb.isRoot}
				<Icon name="lucide:hard-drive" class="w-3.5 h-3.5 shrink-0" />
			{/if}
			<span class="truncate">{crumb.label}</span>
		</button>
	{/each}
{/snippet}

<!-- @container: this pane sits beside a sidebar inside a modal, so its width and
     the viewport's are unrelated. Every breakpoint below measures the pane. -->
<div class="@container flex flex-col h-full min-h-0">
	<!-- Path + actions. Two rows in a narrow pane: on one row the breadcrumb is
	     left with no space at all and the buttons get pushed off the edge. -->
	<div
		class="flex flex-col shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800"
	>
		<div class="flex items-center gap-1 px-2 py-1.5">
			<button
				type="button"
				class={toolbarButton}
				onclick={() => navigate(parentOf(listing?.path ?? '/'))}
				disabled={isAtRoot}
				title="Up one level"
				aria-label="Up one level"
			>
				<Icon name="lucide:corner-left-up" class="w-4 h-4" />
			</button>
			<button type="button" class={toolbarButton} onclick={refresh} title="Refresh" aria-label="Refresh">
				<Icon name="lucide:refresh-cw" class="w-4 h-4 {loading ? 'animate-spin' : ''}" />
			</button>

			<!-- Breadcrumbs share this row only once there is room for them. -->
			<nav
				bind:this={breadcrumbBars[0]}
				class="hidden @2xl:flex flex-1 items-center gap-0.5 min-w-0 overflow-x-auto no-scrollbar px-1"
				aria-label="Path"
			>
				{@render breadcrumbs()}
			</nav>

			<div
				class="flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md flex-1 @2xl:flex-none @2xl:w-44 @4xl:w-64 min-w-0"
			>
				<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Filter…"
					class="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
				/>
				{#if searchQuery}
					<button
						type="button"
						class="shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
						onclick={() => (searchQuery = '')}
						aria-label="Clear filter"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
					</button>
				{/if}
			</div>

			<button
				type="button"
				class={toolbarButton}
				onclick={() => (newFolderOpen = true)}
				title="New folder"
				aria-label="New folder"
			>
				<Icon name="lucide:folder-plus" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class={toolbarButton}
				onclick={() => (newFileOpen = true)}
				title="New file"
				aria-label="New file"
			>
				<Icon name="lucide:file-plus" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class={toolbarButton}
				onclick={() => uploadInput?.click()}
				disabled={transferProgress !== null}
				title="Upload files"
				aria-label="Upload files"
			>
				<Icon name="lucide:upload" class="w-4 h-4" />
			</button>
			<input
				bind:this={uploadInput}
				type="file"
				multiple
				class="hidden"
				onchange={(event) => {
					const input = event.currentTarget as HTMLInputElement;
					if (input.files && input.files.length > 0) void uploadFiles(input.files);
					input.value = '';
				}}
			/>
		</div>

		<nav
			bind:this={breadcrumbBars[1]}
			class="@2xl:hidden flex items-center gap-0.5 px-2 pb-1.5 min-w-0 overflow-x-auto no-scrollbar"
			aria-label="Path"
		>
			{@render breadcrumbs()}
		</nav>
	</div>

	<!-- Bulk action bar, shown only when something is selected -->
	{#if selectedPaths.length > 0}
		<div
			class="flex flex-wrap items-center gap-1 shrink-0 px-3 py-1.5 bg-violet-500/5 border-b border-violet-500/20"
		>
			<span class="text-xs font-semibold text-violet-700 dark:text-violet-300 mr-1 shrink-0">
				{selectedPaths.length} selected
			</span>
			<button
				type="button"
				class={bulkAction}
				onclick={downloadSelected}
				disabled={transferProgress !== null || selectedEntries.every(isDirectory)}
			>
				<Icon name="lucide:download" class="w-3.5 h-3.5" />
				Download
			</button>
			<button type="button" class={bulkAction} onclick={() => startTransfer('move')} disabled={busyLabel !== null}>
				<Icon name="lucide:folder-input" class="w-3.5 h-3.5" />
				Move
			</button>
			<button type="button" class={bulkAction} onclick={() => startTransfer('copy')} disabled={busyLabel !== null}>
				<Icon name="lucide:copy" class="w-3.5 h-3.5" />
				Copy
			</button>
			<button type="button" class={bulkAction} onclick={startCompress} disabled={busyLabel !== null}>
				<Icon name="lucide:file-archive" class="w-3.5 h-3.5" />
				Compress
			</button>
			{#if selectedArchive}
				<button
					type="button"
					class={bulkAction}
					onclick={() => openExtract(selectedArchive)}
					disabled={busyLabel !== null}
				>
					<Icon name="lucide:package-open" class="w-3.5 h-3.5" />
					Extract…
				</button>
			{/if}
			<button
				type="button"
				class="{bulkAction} text-red-600 dark:text-red-400 hover:bg-red-500/10"
				onclick={() => (deleteTargets = selectedEntries)}
				disabled={busyLabel !== null}
			>
				<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
				Delete
			</button>
			<div class="hidden @md:block flex-1"></div>
			<button type="button" class={bulkAction} onclick={() => (selectedPaths = [])}>Clear</button>
		</div>
	{/if}

	{#if busyLabel}
		<div
			class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800"
		>
			<button
				type="button"
				class="shrink-0 opacity-70 hover:opacity-100"
				onclick={dismissBusy}
				title="Carry on browsing — the operation keeps running and the list refreshes when it lands"
				aria-label="Hide"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
			<span class="min-w-0 truncate">{busyLabel}…</span>
		</div>
	{/if}

	{#if transferProgress}
		<div class="shrink-0 px-3 py-1.5 bg-violet-500/5 border-b border-violet-500/20">
			<div class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
				<button
					type="button"
					class="shrink-0 text-slate-400 hover:text-red-500"
					onclick={cancelTransfer}
					title="Cancel"
					aria-label="Cancel transfer"
				>
					<Icon name="lucide:x" class="w-3.5 h-3.5" />
				</button>
				<span class="min-w-0 max-w-[28rem] truncate">
					{transferProgress.verb}
					{transferProgress.name}
				</span>
				<span class="tabular-nums text-slate-500 dark:text-slate-400">
					{#if transferProgress.settling}
						finishing on the host…
					{:else if transferRatio !== null}
						{formatBytes(transferProgress.transferredBytes)} of
						{formatBytes(transferProgress.totalBytes ?? 0)}
						· {Math.round(transferRatio * 100)}%
					{:else}
						{formatBytes(transferProgress.transferredBytes)}
					{/if}
				</span>
			</div>
			<div class="mt-1 h-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
				{#if transferRatio === null}
					<!-- No total to measure against: say so with a moving bar rather
					     than an empty one that reads as "stuck at zero". -->
					<div class="h-full w-full bg-violet-500/50 animate-pulse"></div>
				{:else}
					<div
						class="h-full bg-violet-500 transition-[width] duration-150"
						style:width="{transferRatio * 100}%"
					></div>
				{/if}
			</div>
		</div>
	{/if}

	{#if noticeText}
		<div
			class="shrink-0 flex items-start gap-2 px-3 py-2 text-xs bg-violet-500/5 text-violet-700 dark:text-violet-300"
		>
			<button
				type="button"
				class="shrink-0 mt-0.5 opacity-70 hover:opacity-100"
				onclick={() => (noticeText = null)}
				aria-label="Dismiss"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
			<span class="min-w-0 whitespace-pre-wrap wrap-anywhere">{noticeText}</span>
		</div>
	{/if}

	{#if listError}
		<div
			class="shrink-0 flex items-start gap-2 px-3 py-2 text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
		>
			<button
				type="button"
				class="shrink-0 mt-0.5 opacity-70 hover:opacity-100"
				onclick={() => (listError = null)}
				aria-label="Dismiss"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
			<span class="min-w-0 whitespace-pre-wrap wrap-anywhere">{listError}</span>
		</div>
	{/if}

	<!-- Column header, mirroring the row layout exactly -->
	<div
		class="flex items-center shrink-0 px-2 py-1.5 border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/60"
	>
		<div class="w-9 shrink-0 flex items-center justify-center">
			<input
				type="checkbox"
				class="w-3.5 h-3.5 accent-violet-600 cursor-pointer"
				checked={allVisibleSelected}
				onchange={toggleSelectAll}
				aria-label="Select all"
			/>
		</div>
		<div class={NAME_CELL_HEADER}>Name</div>
		<div class={SIZE_CELL}>Size</div>
		<div class={PERMISSIONS_CELL}>Permissions</div>
		<div class={MODIFIED_CELL}>Modified</div>
		<div class="flex-1"></div>
		<div class="shrink-0 px-2 hidden @md:block">Actions</div>
	</div>

	<!-- Listing -->
	<div class="flex-1 min-h-0 overflow-auto">
		{#if loading && !listing}
			<div class="flex items-center justify-center py-10 text-xs text-slate-500">Loading…</div>
		{:else if entries.length === 0}
			<div class="flex flex-col items-center gap-2 py-10 text-slate-500">
				<Icon name="lucide:folder-open" class="w-8 h-8 opacity-40" />
				<span class="text-xs">{searchQuery ? 'No matches' : 'This directory is empty'}</span>
			</div>
		{:else}
			{#each entries as entry (entry.path)}
				{@const selected = selectedPaths.includes(entry.path)}
				<div
					class="flex items-stretch border-b border-slate-100 dark:border-slate-800/60 transition-colors {selected
						? 'bg-violet-500/10'
						: 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}"
				>
					<div class="w-9 shrink-0 flex items-center justify-center">
						<input
							type="checkbox"
							class="w-3.5 h-3.5 accent-violet-600 cursor-pointer"
							checked={selected}
							onchange={() => toggleSelection(entry.path)}
							aria-label="Select {entry.name}"
						/>
					</div>

					<!-- One hit area spanning the four data columns, filling the row's
					     full height: the highlighted band and the clickable region are
					     the same rectangle, with no dead margin at its edges. -->
					<button
						type="button"
						class="flex-1 min-w-0 flex items-center text-left py-2 cursor-pointer"
						onclick={(event) => openEntry(entry, event)}
						title={entry.path}
					>
						<span class={NAME_CELL_ROW}>
							<span class="flex items-center gap-2 min-w-0">
								<Icon
									name={iconFor(entry)}
									class="w-4 h-4 shrink-0 {isDirectory(entry) ? 'text-violet-500' : 'text-slate-400'}"
								/>
								<span class="truncate text-sm text-slate-800 dark:text-slate-200">{entry.name}</span>
								{#if entry.linkTarget}
									<span class="hidden @md:inline truncate text-xs text-slate-400">
										→ {entry.linkTarget}
									</span>
								{/if}
							</span>
							<!-- The columns that dropped out at this width, folded under the
							     name so the information is still there. -->
							<span class="@md:hidden pl-6 truncate text-[11px] text-slate-500 dark:text-slate-400">
								{isDirectory(entry) ? 'Folder' : formatBytes(entry.size)} · {entry.permissions} ·
								{formatTime(entry.modifiedAt)}
							</span>
						</span>
						<span class="{SIZE_CELL} text-xs text-slate-500 dark:text-slate-400 tabular-nums">
							{isDirectory(entry) ? '—' : formatBytes(entry.size)}
						</span>
						<span class="{PERMISSIONS_CELL} text-xs text-slate-500 dark:text-slate-400 font-mono">
							{entry.permissions}
						</span>
						<span class="{MODIFIED_CELL} text-xs text-slate-500 dark:text-slate-400 truncate">
							{formatTime(entry.modifiedAt)}
						</span>
						<span class="flex-1"></span>
					</button>

					<div class="flex items-center justify-end gap-0.5 px-1">
						{#if isArchive(entry)}
							<button
								type="button"
								class={rowAction}
								onclick={() => openExtract(entry)}
								title="Extract…"
								aria-label="Extract"
							>
								<Icon name="lucide:package-open" class="w-3.5 h-3.5" />
							</button>
						{/if}
						{#if !isDirectory(entry)}
							<button
								type="button"
								class={rowAction}
								onclick={() => openFile(entry)}
								title={viewerKindFor(entry) === 'text' ? 'Edit' : 'Preview'}
								aria-label={viewerKindFor(entry) === 'text' ? 'Edit' : 'Preview'}
							>
								<Icon
									name={viewerKindFor(entry) === 'text' ? 'lucide:pencil-line' : 'lucide:eye'}
									class="w-3.5 h-3.5"
								/>
							</button>
							<button
								type="button"
								class={rowAction}
								onclick={() => download(entry)}
								disabled={transferProgress !== null}
								title="Download"
								aria-label="Download"
							>
								<Icon name="lucide:download" class="w-3.5 h-3.5" />
							</button>
						{/if}
						<button
							type="button"
							class={rowAction}
							onclick={() => (renameTarget = entry)}
							title="Rename"
							aria-label="Rename"
						>
							<Icon name="lucide:text-cursor-input" class="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							class={rowAction}
							onclick={() => {
								chmodTarget = entry;
								chmodValue = entry.mode.toString(8).padStart(3, '0');
							}}
							title="Permissions"
							aria-label="Permissions"
						>
							<Icon name="lucide:shield" class="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							class="{rowAction} hover:text-red-500 hover:bg-red-500/10"
							onclick={() => (deleteTargets = [entry])}
							title="Delete"
							aria-label="Delete"
						>
							<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
						</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>

	<!-- Footer: counts and the account's real disk figures -->
	<div
		class="shrink-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400"
	>
		<span class="shrink-0">{entries.length} item{entries.length === 1 ? '' : 's'}</span>
		{#if diskSummary}
			<div class="flex items-center gap-2 min-w-0">
				{#if diskSummary.ratio !== null}
					<div class="w-16 @md:w-20 h-1 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden shrink-0">
						<div
							class="h-full {diskSummary.ratio > 0.9
								? 'bg-red-500'
								: diskSummary.ratio > 0.75
									? 'bg-amber-500'
									: 'bg-emerald-500'}"
							style:width="{Math.min(100, diskSummary.ratio * 100)}%"
						></div>
					</div>
				{/if}
				<span class="truncate" title="{diskSummary.label}: {diskSummary.text}">
					{diskSummary.text}
				</span>
				<span class="hidden @md:inline shrink-0 opacity-70">· {diskSummary.label}</span>
			</div>
		{/if}
	</div>
</div>

<Dialog
	bind:isOpen={newFolderOpen}
	onClose={() => (newFolderOpen = false)}
	title="New folder"
	inputValue=""
	inputPlaceholder="Folder name"
	confirmText="Create"
	onConfirm={createFolder}
/>

<Dialog
	bind:isOpen={newFileOpen}
	onClose={() => (newFileOpen = false)}
	title="New file"
	inputValue=""
	inputPlaceholder="File name"
	confirmText="Create"
	onConfirm={createFile}
/>

<Dialog
	isOpen={renameTarget !== null}
	onClose={() => (renameTarget = null)}
	title="Rename"
	inputValue={renameTarget?.name ?? ''}
	inputPlaceholder="New name"
	confirmText="Rename"
	onConfirm={commitRename}
/>

<Dialog
	isOpen={chmodTarget !== null}
	onClose={() => (chmodTarget = null)}
	title="Permissions"
	message="Octal mode for “{chmodTarget?.name ?? ''}”, e.g. 644 for a file or 755 for a directory."
	inputValue={chmodValue}
	inputPlaceholder="644"
	confirmText="Apply"
	onConfirm={commitChmod}
/>

<Dialog
	isOpen={deleteTargets.length > 0}
	onClose={() => (deleteTargets = [])}
	type="warning"
	title={deleteTargets.length > 1 ? `Delete ${deleteTargets.length} items` : 'Delete'}
	message={deleteTargets.length > 1
		? `Delete ${deleteTargets.length} selected items? Directories are removed with everything inside them. This cannot be undone.`
		: deleteTargets[0] && deleteTargets[0].type === 'directory'
			? `Delete “${deleteTargets[0].name}” and everything inside it? This cannot be undone.`
			: `Delete “${deleteTargets[0]?.name ?? ''}”? This cannot be undone.`}
	confirmText="Delete"
	onConfirm={commitDelete}
/>

<!-- Compress: a Modal, because a bad archive name has to be reportable without
     the dialog closing itself first. -->
<Modal
	bind:isOpen={compressOpen}
	onClose={() => (compressOpen = false)}
	bare
	mobileFullscreen
	ariaLabelledBy="ssh-compress-title"
	className="flex flex-col w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden"
>
	{#snippet children()}
		<header
			class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800"
		>
			<h2 id="ssh-compress-title" class="text-sm font-semibold text-slate-900 dark:text-slate-100 m-0">
				Compress {selectedPaths.length} item{selectedPaths.length === 1 ? '' : 's'}
			</h2>
			<button
				type="button"
				class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-violet-500/10"
				onclick={() => (compressOpen = false)}
				aria-label="Close"
			>
				<Icon name="lucide:x" class="w-5 h-5" />
			</button>
		</header>
		<div class="flex flex-col gap-3 p-4">
			<label class="flex flex-col gap-1">
				<span class="text-xs text-slate-500 dark:text-slate-400">Archive name</span>
				<input type="text" bind:value={compressName} class={fieldClass} placeholder="archive" />
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs text-slate-500 dark:text-slate-400">Format</span>
				<select bind:value={compressFormat} class={fieldClass}>
					<option value="zip">zip</option>
					<option value="tar.gz">tar.gz</option>
				</select>
			</label>

			{#if compressNameTaken}
				<label class="flex flex-col gap-1">
					<span class="text-xs text-amber-600 dark:text-amber-400 wrap-anywhere">
						“{compressFileName}” already exists here
					</span>
					<select bind:value={compressConflict} class={fieldClass}>
						<option value="rename">Use a free name, e.g. “{compressFreeNamePreview}”</option>
						<option value="overwrite">Replace it</option>
					</select>
				</label>
			{/if}

			{#if compressError}
				<span class="text-xs text-red-600 dark:text-red-400">{compressError}</span>
			{/if}

			<span class="text-xs text-slate-500 dark:text-slate-500">
				Written into {listing?.path ?? ''}. Needs <code>zip</code> or <code>tar</code> on the remote
				host.
			</span>
		</div>
		<footer
			class="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800"
		>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
				onclick={() => (compressOpen = false)}
			>
				Cancel
			</button>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md bg-violet-600 hover:bg-violet-700 text-white"
				onclick={commitCompress}
			>
				Compress
			</button>
		</footer>
	{/snippet}
</Modal>

<!-- Move / copy destination picker -->
<Modal
	isOpen={transferMode !== null}
	onClose={() => (transferMode = null)}
	bare
	mobileFullscreen
	ariaLabelledBy="ssh-transfer-title"
	className="flex flex-col w-full max-w-lg h-[60dvh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden"
>
	{#snippet children()}
		<header
			class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0"
		>
			<h2 id="ssh-transfer-title" class="text-sm font-semibold text-slate-900 dark:text-slate-100 m-0">
				{transferMode === 'move' ? 'Move' : 'Copy'}
				{selectedPaths.length} item{selectedPaths.length === 1 ? '' : 's'} to…
			</h2>
			<button
				type="button"
				class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-violet-500/10"
				onclick={() => (transferMode = null)}
				aria-label="Close"
			>
				<Icon name="lucide:x" class="w-5 h-5" />
			</button>
		</header>

		<div class="flex items-center gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
			<button
				type="button"
				class={toolbarButton}
				onclick={() => loadPicker(parentOf(pickerPath))}
				disabled={pickerPath === '/'}
				title="Up one level"
				aria-label="Up one level"
			>
				<Icon name="lucide:corner-left-up" class="w-4 h-4" />
			</button>
			<span class="flex-1 min-w-0 truncate text-xs font-mono text-slate-700 dark:text-slate-300">
				{pickerPath}
			</span>
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto p-2">
			{#if pickerLoading}
				<div class="flex items-center justify-center py-8 text-xs text-slate-500">Loading…</div>
			{:else if pickerError}
				<div class="px-3 py-2 text-xs text-red-600 dark:text-red-400">{pickerError}</div>
			{:else if pickerEntries.length === 0}
				<div class="flex items-center justify-center py-8 text-xs text-slate-500">
					No sub-folders here
				</div>
			{:else}
				{#each pickerEntries as entry (entry.path)}
					<button
						type="button"
						class="flex items-center gap-2 w-full px-3 py-2 rounded-md text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
						onclick={() => loadPicker(entry.path)}
					>
						<Icon name="lucide:folder" class="w-4 h-4 text-violet-500 shrink-0" />
						<span class="truncate">{entry.name}</span>
					</button>
				{/each}
			{/if}
		</div>

		<footer
			class="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0"
		>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
				onclick={() => (transferMode = null)}
			>
				Cancel
			</button>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md bg-violet-600 hover:bg-violet-700 text-white"
				onclick={commitTransfer}
			>
				{transferMode === 'move' ? 'Move here' : 'Copy here'}
			</button>
		</footer>
	{/snippet}
</Modal>

<!-- "That name is taken" prompt, between choosing a destination and moving -->
<Modal
	isOpen={conflictPrompt !== null}
	onClose={() => (conflictPrompt = null)}
	bare
	mobileFullscreen
	ariaLabelledBy="ssh-conflict-title"
	className="flex flex-col w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden"
>
	{#snippet children()}
		<header
			class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800"
		>
			<h2 id="ssh-conflict-title" class="text-sm font-semibold text-slate-900 dark:text-slate-100 m-0">
				{conflictPrompt?.conflicts.length === 1
					? 'That name is already taken'
					: `${conflictPrompt?.conflicts.length ?? 0} names are already taken`}
			</h2>
			<button
				type="button"
				class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-violet-500/10"
				onclick={() => (conflictPrompt = null)}
				aria-label="Close"
			>
				<Icon name="lucide:x" class="w-5 h-5" />
			</button>
		</header>
		<div class="flex flex-col gap-3 p-4">
			<p class="text-xs text-slate-600 dark:text-slate-400 m-0">
				{conflictPrompt?.destination ?? ''} already has
				{conflictPrompt?.conflicts.length === 1 ? 'an entry' : 'entries'} with
				{conflictPrompt?.conflicts.length === 1 ? 'this name' : 'these names'}:
			</p>
			<ul class="flex flex-col gap-1 max-h-40 overflow-y-auto m-0 p-0 list-none">
				{#each conflictPrompt?.conflicts ?? [] as conflict (conflict.targetPath)}
					<li class="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
						<Icon
							name={conflict.targetType === 'directory' ? 'lucide:folder' : 'lucide:file'}
							class="w-3.5 h-3.5 shrink-0 {conflict.targetType === 'directory'
								? 'text-violet-500'
								: 'text-slate-400'}"
						/>
						<span class="truncate">{conflict.name}</span>
					</li>
				{/each}
			</ul>
			<p class="text-xs text-slate-500 dark:text-slate-500 m-0">
				Replacing a folder deletes everything inside it first.
			</p>
		</div>
		<footer
			class="flex flex-wrap items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800"
		>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
				onclick={() => (conflictPrompt = null)}
			>
				Cancel
			</button>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
				onclick={() => resolveConflicts('skip')}
			>
				Skip these
			</button>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md text-red-600 dark:text-red-400 hover:bg-red-500/10"
				onclick={() => resolveConflicts('overwrite')}
			>
				Replace
			</button>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md bg-violet-600 hover:bg-violet-700 text-white"
				onclick={() => resolveConflicts('rename')}
			>
				Keep both
			</button>
		</footer>
	{/snippet}
</Modal>

<!-- Extract options: where the contents land, and what happens to what is there -->
<Modal
	isOpen={extractTarget !== null}
	onClose={() => (extractTarget = null)}
	bare
	mobileFullscreen
	ariaLabelledBy="ssh-extract-title"
	className="flex flex-col w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden"
>
	{#snippet children()}
		<header
			class="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800"
		>
			<h2
				id="ssh-extract-title"
				class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate m-0"
			>
				Extract “{extractTarget?.name ?? ''}”
			</h2>
			<button
				type="button"
				class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-violet-500/10 shrink-0"
				onclick={() => (extractTarget = null)}
				aria-label="Close"
			>
				<Icon name="lucide:x" class="w-5 h-5" />
			</button>
		</header>

		<div class="flex flex-col gap-3 p-4 overflow-y-auto">
			{#if extractLoading}
				<span class="text-xs text-slate-500 dark:text-slate-400">Reading the archive…</span>
			{:else if extractInfo}
				<span class="text-xs text-slate-500 dark:text-slate-400 wrap-anywhere">
					Holds {extractInfo.topLevelNames.length}{extractInfo.truncated ? '+' : ''} top-level
					item{extractInfo.topLevelNames.length === 1 ? '' : 's'}:
					{extractInfo.topLevelNames.slice(0, 6).join(', ')}{extractInfo.topLevelNames.length > 6
						? ', …'
						: ''}
				</span>
			{/if}

			<fieldset class="flex flex-col gap-1 m-0 p-0 border-0">
				<legend class="text-xs text-slate-500 dark:text-slate-400 mb-1 p-0">
					Where the contents go
				</legend>
				{#each extractModeChoices as choice (choice.value)}
					<label
						class="flex items-start gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 {extractMode ===
						choice.value
							? 'bg-violet-500/10'
							: ''}"
					>
						<input
							type="radio"
							name="ssh-extract-mode"
							class="mt-0.5 accent-violet-600"
							checked={extractMode === choice.value}
							onchange={() => chooseExtractMode(choice.value)}
						/>
						<span class="flex flex-col min-w-0">
							<span class="text-sm text-slate-800 dark:text-slate-200">{choice.label}</span>
							<span class="text-xs text-slate-500 dark:text-slate-400 wrap-anywhere">
								{choice.hint}
							</span>
						</span>
					</label>
				{/each}
			</fieldset>

			{#if resolvedExtractMode === 'folder'}
				<label class="flex flex-col gap-1">
					<span class="text-xs text-slate-500 dark:text-slate-400">Folder name</span>
					<input type="text" bind:value={extractFolderName} class={fieldClass} placeholder="archive" />
				</label>
			{/if}

			<label class="flex flex-col gap-1">
				<span class="text-xs text-slate-500 dark:text-slate-400">
					{resolvedExtractMode === 'folder'
						? 'If that folder already exists'
						: 'If a file is already there'}
				</span>
				<select bind:value={extractConflict} class={fieldClass}>
					{#each extractConflictChoices as choice (choice.value)}
						<option value={choice.value}>{choice.label}</option>
					{/each}
				</select>
			</label>

			{#if extractHereConflicts.length > 0}
				<span class="text-xs text-amber-600 dark:text-amber-400 wrap-anywhere">
					{extractHereConflicts.length}
					{extractHereConflicts.length === 1 ? 'name is' : 'names are'} already used here:
					{extractHereConflicts.slice(0, 6).join(', ')}
				</span>
			{/if}
		</div>

		<footer
			class="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800"
		>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
				onclick={() => (extractTarget = null)}
			>
				Cancel
			</button>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md bg-violet-600 hover:bg-violet-700 text-white"
				onclick={commitExtract}
			>
				Extract
			</button>
		</footer>
	{/snippet}
</Modal>

<!-- Inline editor for remote text files -->
<Modal
	isOpen={editorEntry !== null}
	onClose={() => (editorEntry = null)}
	bare
	mobileFullscreen
	ariaLabelledBy="ssh-file-editor-title"
	className="flex flex-col w-full max-w-[80vw] h-[80dvh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden"
>
	{#snippet children()}
		<header
			class="flex items-center justify-between gap-3 px-4 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0"
		>
			<h2
				id="ssh-file-editor-title"
				class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate m-0"
			>
				{editorEntry?.path ?? ''}
			</h2>
			<div class="flex items-center gap-2 shrink-0">
				{#if editorTruncated && viewerKind === 'text'}
					<span class="text-xs text-amber-600 dark:text-amber-400">
						Showing the first 2 MB — saving would truncate the file
					</span>
				{/if}
				{#if viewerKind === 'text'}
					<button
						type="button"
						class="px-3 py-1.5 text-sm rounded-md bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
						onclick={saveEditor}
						disabled={editorSaving || editorLoading || editorTruncated}
					>
						{editorSaving ? 'Saving…' : 'Save'}
					</button>
				{:else if editorEntry}
					<button
						type="button"
						class="px-3 py-1.5 text-sm rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
						onclick={() => editorEntry && download(editorEntry)}
						disabled={transferProgress !== null}
					>
						Download
					</button>
				{/if}
				<button
					type="button"
					class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-violet-500/10"
					onclick={() => (editorEntry = null)}
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</div>
		</header>
		{#if editorError}
			<div class="px-4 py-2 text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300">
				{editorError}
			</div>
		{/if}
		<div class="flex-1 min-h-0">
			{#if editorLoading}
				<div class="h-full flex items-center justify-center text-xs text-slate-500">
					Reading {editorEntry?.name ?? 'file'}…
				</div>
			{:else if editorEntry && !editorError}
				{#if viewerKind === 'media'}
					<!-- The same viewer the Files panel uses, pointed at the remote
					     host: a video plays, a PDF renders, an image is an image. -->
					<MediaPreview
						fileName={editorEntry.name}
						filePath={editorEntry.path}
						loadBlob={loadRemoteBlob}
					/>
				{:else if viewerKind === 'text'}
					<MonacoCodeEditor
						bind:value={editorText}
						language={detectLanguageFromFilename(editorEntry.name)}
						path={editorEntry.path}
					/>
				{:else}
					<div class="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
						<Icon
							name={isArchive(editorEntry) ? 'lucide:file-archive' : 'lucide:file-digit'}
							class="w-14 h-14 text-slate-300 dark:text-slate-600"
						/>
						<h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100 m-0">
							{viewerKind === 'oversized' ? 'Too large to preview' : 'Not a text file'}
						</h3>
						<p class="text-xs text-slate-500 dark:text-slate-400 max-w-sm m-0">
							{#if viewerKind === 'oversized'}
								{editorEntry.name} is {formatBytes(editorEntry.size)}. Downloading it beats
								pulling it through the browser's memory to look at it.
							{:else if isArchive(editorEntry)}
								{editorEntry.name} is an archive. Extract it to see what is inside, or
								download it as it is.
							{:else}
								{editorEntry.name} holds bytes rather than text, so there is nothing to
								show here.
							{/if}
						</p>
						<div class="flex items-center gap-2">
							{#if isArchive(editorEntry)}
								<button
									type="button"
									class="px-3 py-1.5 text-sm rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
									onclick={() => {
										const archive = editorEntry;
										editorEntry = null;
										if (archive) void openExtract(archive);
									}}
								>
									Extract…
								</button>
							{/if}
							<button
								type="button"
								class="px-3 py-1.5 text-sm rounded-md bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
								onclick={() => editorEntry && download(editorEntry)}
								disabled={transferProgress !== null}
							>
								Download
							</button>
						</div>
					</div>
				{/if}
			{/if}
		</div>
	{/snippet}
</Modal>
