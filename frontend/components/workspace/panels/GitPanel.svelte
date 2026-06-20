<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { showError, showInfo } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import ws from '$frontend/utils/ws';
	import { acquireFileWatch } from '$frontend/utils/file-watch';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { isPreviewableFile, isBinaryFile } from '$frontend/utils/file-type';
	import { getGitStatusLabel, getGitStatusColor } from '$frontend/utils/git-status';
	import { chatService } from '$frontend/services/chat/chat.service';
	import { showPanel } from '$frontend/stores/ui/workspace.svelte';
	import {
		gitDraft,
		setGitSnapshotProvider,
		captureActiveGitUiState,
		loadGitUiState,
		markGitUiDirty,
		type GitUiState,
		type GitActiveDiff
	} from '$frontend/stores/features/git-workspace.svelte';
	import { detectLanguageFromFilename } from '$frontend/components/common/editor/monaco-languages';
	import type { IconName } from '$shared/types/ui/icons';
	import type {
		GitStatus,
		GitBranch,
		GitBranchInfo,
		GitFileChange,
		GitFileDiff,
		GitCommit,
		GitConflictFile,
		GitStashEntry,
		GitTag,
		GitRemote
	} from '$shared/types/git';

	// Sub-components
	import CommitForm from '$frontend/components/git/CommitForm.svelte';
	import type { GitMoreAction } from '$frontend/components/git/GitMoreMenu.svelte';
	import ChangesSection from '$frontend/components/git/ChangesSection.svelte';
	import DiffViewer from '$frontend/components/git/DiffViewer.svelte';
	import GitLog from '$frontend/components/git/GitLog.svelte';
	import CommitFileList from '$frontend/components/git/CommitFileList.svelte';
	import ConflictResolver from '$frontend/components/git/ConflictResolver.svelte';

	// Derived state
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectId = $derived(projectState.currentProject?.id || '');

	// Git state
	let isRepo = $state(false);
	let isLoading = $state(false);
	let gitStatus = $state<GitStatus>({ staged: [], unstaged: [], untracked: [], conflicted: [] });
	let branchInfo = $state<GitBranchInfo | null>(null);
	let isCommitting = $state(false);

	// Repo is in a transitional state (detached HEAD or an in-progress operation
	// like rebase/merge/cherry-pick). Branch-targeted actions (push/pull/merge)
	// must be blocked while this is true — running them would operate on a detached
	// HEAD with no real branch name.
	const repoBusy = $derived(Boolean(branchInfo?.detached || branchInfo?.operation));
	const repoBusyReason = $derived(
		branchInfo?.operation
			? `A ${branchInfo.operation} is in progress — finish or abort it first.`
			: branchInfo?.detached
				? 'HEAD is detached (no branch checked out).'
				: ''
	);

	/**
	 * Guard for branch-targeted actions. Returns true (and surfaces a message) when
	 * the repo is mid-operation/detached, so callers should bail out.
	 */
	function blockedWhileBusy(action: string): boolean {
		if (!repoBusy) return false;
		showError(`Cannot ${action}`, repoBusyReason);
		return true;
	}

	// Remote state
	let remotes = $state<GitRemote[]>([]);
	let selectedRemote = $state('origin');

	function loadSelectedRemote(pid: string) {
		try {
			const saved = localStorage.getItem(`clopen:selectedRemote:${pid}`);
			if (saved) selectedRemote = saved;
		} catch { /* ignore */ }
	}

	function saveSelectedRemote() {
		if (!projectId) return;
		try {
			localStorage.setItem(`clopen:selectedRemote:${projectId}`, selectedRemote);
		} catch { /* ignore */ }
	}
	let deletingRemoteBranch = $state<string | null>(null);

	$effect(() => {
		if (!editingRemote) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && !savingRemote) {
				editingRemote = null;
				editRemoteName = '';
				editRemoteUrl = '';
			}
		};
		document.addEventListener('keydown', handler);
		return () => document.removeEventListener('keydown', handler);
	});

	$effect(() => {
		if (projectId && selectedRemote) saveSelectedRemote();
	});
	let pushingBranch = $state<string | null>(null);
	let fetchingRemote = $state<string | null>(null);
	let branchesLoadToken = 0;
	let isLoadingBranches = $state(false);
	let showAddRemoteForm = $state(false);
	let newRemoteName = $state('');
	let newRemoteUrl = $state('');
	let addingRemote = $state(false);
	let editingRemote = $state<string | null>(null);
	let editRemoteName = $state('');
	let editRemoteUrl = $state('');
	let savingRemote = $state(false);

	function copyToClipboard(text: string) {
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			navigator.clipboard.writeText(text)
				.then(() => showInfo('Copied', `Branch name "${text}" copied to clipboard`))
				.catch(() => {});
		}
	}

	function copyCommitHash(hash: string, e: MouseEvent) {
		e.stopPropagation();
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			navigator.clipboard.writeText(hash)
				.then(() => showInfo('Copied', `Commit ${hash.slice(0, 7)} copied to clipboard`))
				.catch(() => {});
		}
	}

	/** Split a path into its file name and directory, like the History detail list. */
	function splitPath(path: string): { fileName: string; dirPath: string } {
		const parts = path.split(/[\\/]/);
		const fileName = parts.pop() || path;
		return { fileName, dirPath: parts.join('/') };
	}

	async function handleDeleteRemoteBranch(remote: string, branch: string) {
		requestConfirm({
			title: 'Delete remote branch',
			message: `Delete branch "${branch}" from "${remote}"? This cannot be undone.`,
			type: 'error',
			confirmText: 'Delete',
			onConfirm: async () => {
				if (!projectId) return;
				const key = `${remote}/${branch}`;
				deletingRemoteBranch = key;
				try {
					await ws.http('git:delete-remote-branch', { projectId, remote, branch });
					await loadBranches();
				} catch (err) {
					debug.error('git', 'Failed to delete remote branch:', err);
				} finally {
					deletingRemoteBranch = null;
				}
			}
		});
	}

	// View state
	let activeView = $state<'changes' | 'log' | 'branches' | 'more'>('changes');
	// Sub-tab for the "More" view (Tags / Stash / Contributors)
	let moreSubTab = $state<'tags' | 'stash' | 'contributors'>('tags');
	let viewMode = $state<'list' | 'diff'>('list');
	let showMergeBranchModal = $state(false);
	let mergeBranchName = $state('');
	let mergeMode = $state<'default' | 'no-ff'>('default');
	let showConflictResolver = $state(false);
	const mergeableBranches = $derived(branchInfo?.local.filter(branch => !branch.isCurrent) ?? []);

	// Local branch names that already exist on at least one remote
	// (matched by suffix `/{name}` on any remote branch). Used to decide
	// whether the push button should appear — the backend's `upstream`
	// field isn't reliably populated, so we cross-reference against the
	// remote branch list instead.
	const pushedBranchNames = $derived.by(() => {
		const set = new Set<string>();
		const remotes = branchInfo?.remote ?? [];
		for (const r of remotes) {
			const slash = r.name.indexOf('/');
			if (slash >= 0) {
				const localName = r.name.substring(slash + 1);
				set.add(localName);
			}
		}
		return set;
	});
	const selectedMergeBranch = $derived(
		mergeableBranches.find(branch => branch.name === mergeBranchName) ?? null
	);

	$effect(() => {
		if (!showMergeBranchModal) return;
		if (!mergeableBranches.some(branch => branch.name === mergeBranchName)) {
			mergeBranchName = mergeableBranches[0]?.name ?? '';
		}
	});

	// Git init state
	let isInitializing = $state(false);

	// Stash state
	let stashEntries = $state<GitStashEntry[]>([]);
	let isStashLoading = $state(false);
	let showStashSaveForm = $state(false);
	let stashMessage = $state('');
	// Inline expanded stash entries → their file list (lazy-loaded), like the
	// per-commit file list under a branch.
	let expandedStashes = $state<Set<number>>(new Set());
	let stashFileState = $state<Record<number, { files: GitFileDiff[]; isLoading: boolean }>>({});

	// Tags state
	let tags = $state<GitTag[]>([]);
	let isTagsLoading = $state(false);
	let showCreateTagForm = $state(false);
	let newTagName = $state('');
	let newTagMessage = $state('');

	// Inline create branch state
	let showCreateBranchForm = $state(false);
	let newBranchName = $state('');

	// Branches view state
	let branchesSearchQuery = $state('');
	let branchesSubTab = $state<'local' | 'remote'>('local');

	const filteredLocalBranches = $derived(
		branchInfo?.local.filter(b =>
			!branchesSearchQuery || b.name.toLowerCase().includes(branchesSearchQuery.toLowerCase())
		) ?? []
	);

	const filteredRemoteBranches = $derived(
		branchInfo?.remote.filter(b =>
			!branchesSearchQuery || b.name.toLowerCase().includes(branchesSearchQuery.toLowerCase())
		) ?? []
	);

	interface BranchCommitState {
		commits: GitCommit[];
		isLoading: boolean;
		hasMore: boolean;
		skip: number;
	}
	interface BranchCommitFileState {
		files: GitFileDiff[];
		isLoading: boolean;
	}

	let expandedBranches = $state<Set<string>>(new Set());
	let branchCommitState = $state<Record<string, BranchCommitState>>({});
	let expandedBranchCommits = $state<Set<string>>(new Set());
	let branchCommitFileState = $state<Record<string, BranchCommitFileState>>({});

	// Contributor state
	let contributors = $state<{ name: string; email: string; count: number }[]>([]);
	let isContributorsLoading = $state(false);

	// Tab system (like Files panel)
	interface DiffTab {
		id: string;
		filePath: string;
		fileName: string;
		section: string;
		diff: GitFileDiff | null;
		diffs: GitFileDiff[];
		isLoading: boolean;
		commitHash?: string;
		status?: string;
		/** Saved diff-editor scroll, used to restore on re-open after refresh/switch. */
		scrollTop?: number;
	}

	// Per-view tab isolation — each view (Changes, History, Branches, More) has its own tabs
	const _tabStore: Record<string, DiffTab[]> = { changes: [], log: [], branches: [], more: [] };
	const _activeTabStore: Record<string, string | null> = { changes: null, log: null, branches: null, more: null };
	const _viewModeStore: Record<string, 'list' | 'diff'> = { changes: 'list', log: 'list', branches: 'list', more: 'list' };

	let openTabs = $state<DiffTab[]>([]);
	let activeTabId = $state<string | null>(null);

	const activeTab = $derived(openTabs.find(t => t.id === activeTabId) || null);

	// Latest diff-editor scroll for the active tab. Kept as a plain (non-reactive)
	// ref so high-frequency scroll events don't churn `openTabs`; the snapshot
	// provider reads it on demand and `markGitUiDirty()` (debounced) persists it.
	let liveDiffScroll: { tabId: string | null; top: number } = { tabId: null, top: 0 };

	function handleDiffScroll(top: number) {
		liveDiffScroll = { tabId: activeTabId, top };
		markGitUiDirty();
	}

	/** Current scroll of the active diff tab — live value if we have one, else the saved one. */
	function activeDiffScrollTop(): number {
		if (activeTab && liveDiffScroll.tabId === activeTab.id) return liveDiffScroll.top;
		return activeTab?.scrollTop ?? 0;
	}

	function switchToView(newView: typeof activeView) {
		// Save current view's tab state
		_tabStore[activeView] = openTabs;
		_activeTabStore[activeView] = activeTabId;
		_viewModeStore[activeView] = viewMode;
		// Restore target view's tab state
		openTabs = _tabStore[newView] || [];
		activeTabId = _activeTabStore[newView] || null;
		viewMode = _viewModeStore[newView] || 'list';
		activeView = newView;
		// Remember which view this project is on (per-project, server-persisted).
		markGitUiDirty();
	}

	function resetAllViewTabs() {
		for (const key of Object.keys(_tabStore)) {
			_tabStore[key] = [];
			_activeTabStore[key] = null;
			_viewModeStore[key] = 'list';
		}
		openTabs = [];
		activeTabId = null;
		viewMode = 'list';
	}

	// Diff state
	const isDiffLoading = $state(false);

	// Log state
	let commits = $state<GitCommit[]>([]);
	let isLogLoading = $state(false);
	let logHasMore = $state(false);
	let logSkip = $state(0);
	// A commit detail to re-open once the log finishes loading (per-project restore).
	let pendingSelectedCommitHash = $state<string | null>(null);
	// A diff tab to re-open once its data source is loaded (per-project restore):
	// for changes sections, once git status is in; for commit files, once the
	// commit detail's file list is fetched.
	let pendingActiveDiff = $state<GitActiveDiff | null>(null);

	// Commit detail state — when set, History view shows a per-commit file list
	// instead of the commit log. Cleared via the back button.
	let selectedCommit = $state<{
		hash: string;
		hashShort: string;
		message: string;
		author: string;
		files: GitFileDiff[];
		isLoading: boolean;
	} | null>(null);

	// Conflict state
	let conflictFiles = $state<GitConflictFile[]>([]);
	let isConflictLoading = $state(false);
	let conflictInitialPath = $state<string | null>(null);

	// Container width for responsive layout (same threshold as Files: 800)
	let containerRef = $state<HTMLDivElement | null>(null);
	let containerWidth = $state(0);
	let leftPanelWidth = $state(256); // default w-64
	let isResizing = $state(false);
	const TWO_COLUMN_THRESHOLD = $derived(Math.round(600 * (settings.fontSize / 13)));
	const isTwoColumnMode = $derived(containerWidth >= TWO_COLUMN_THRESHOLD);

	// Track last project for re-fetch
	let lastProjectId = $state('');

	// (File watcher subscription managed by $effect with auto-cleanup)

	// Active diff file path (for highlighting in list)
	const activeFilePath = $derived(activeTab?.filePath || null);

	// ============================
	// Confirm Dialog State
	// ============================
	let showConfirmDialog = $state(false);
	let confirmConfig = $state({
		title: '',
		message: '',
		type: 'warning' as 'info' | 'warning' | 'error' | 'success',
		confirmText: 'Confirm',
		cancelText: 'Cancel',
		onConfirm: () => {}
	});

	function requestConfirm(config: {
		title: string;
		message: string;
		type?: 'info' | 'warning' | 'error' | 'success';
		confirmText?: string;
		cancelText?: string;
		onConfirm: () => void;
	}) {
		confirmConfig = {
			title: config.title,
			message: config.message,
			type: config.type || 'warning',
			confirmText: config.confirmText || 'Confirm',
			cancelText: config.cancelText || 'Cancel',
			onConfirm: config.onConfirm
		};
		showConfirmDialog = true;
	}

	function closeConfirmDialog() {
		showConfirmDialog = false;
	}

	// ============================
	// Git Init
	// ============================

	async function handleInit() {
		if (!projectId) return;
		isInitializing = true;
		try {
			await ws.http('git:init', { projectId, defaultBranch: 'main' });
			await loadAll();
		} catch (err) {
			debug.error('git', 'Git init failed:', err);
			showError('Git Init Failed', err instanceof Error ? err.message : 'Unknown error');
		} finally {
			isInitializing = false;
		}
	}

	// ============================
	// Data Loading
	// ============================

	async function loadAll() {
		if (!hasActiveProject || !projectId) return;
		isLoading = true;
		try {
			// Stash + tags are loaded here too (not just lazily on their view) so the
			// Stash/Tags badge counts are correct immediately after a switch/refresh,
			// not only once the user opens those views.
			await Promise.all([loadStatus(), loadBranches(), loadRemotes(), loadStash(), loadTags(), loadContributors()]);
		} catch (err) {
			debug.error('git', 'Failed to load git data:', err);
		} finally {
			isLoading = false;
		}
	}

	async function loadStatus() {
		if (!projectId) return;
		try {
			const data = await ws.http('git:status', { projectId });
			isRepo = data.isRepo;
			if (data.isRepo) {
				gitStatus = {
					staged: data.staged,
					unstaged: data.unstaged,
					untracked: data.untracked,
					conflicted: data.conflicted
				};
			}
		} catch (err) {
			debug.error('git', 'Failed to load status:', err);
		}
	}

	async function loadBranches(remote?: string): Promise<GitBranchInfo | null> {
		if (!projectId) return null;
		const useRemote = remote ?? selectedRemote;
		const token = ++branchesLoadToken;
		isLoadingBranches = true;
		try {
			const data = await ws.http('git:branches', { projectId, selectedRemote: useRemote });
			if (token !== branchesLoadToken) return null; // stale — newer load in flight
			branchInfo = data;
			return data;
		} catch (err) {
			debug.error('git', 'Failed to load branches:', err);
			return null;
		} finally {
			if (token === branchesLoadToken) isLoadingBranches = false;
		}
	}

	async function loadRemotes() {
		if (!projectId) return;
		try {
			const list = await ws.http('git:remotes', { projectId });
			remotes = list;
			// Only restore from localStorage if current selection is empty or invalid
			// (otherwise we'd overwrite the user's just-clicked star with the stale saved value)
			if (!selectedRemote || !list.find(r => r.name === selectedRemote)) {
				loadSelectedRemote(projectId);
				if (list.length > 0 && !list.find(r => r.name === selectedRemote)) {
					selectedRemote = list[0].name;
				}
			}
		} catch (err) {
			debug.error('git', 'Failed to load remotes:', err);
		}
	}

	async function loadLog(reset = false) {
		if (!projectId) return;
		// Guard against concurrent loads. On restore both the explicit load and the
		// reactive view effect can fire for the same view; without this they'd
		// double-fetch (and a failed first attempt is what intermittently left the
		// History view stuck on "No commits yet").
		if (isLogLoading) return;
		isLogLoading = true;
		try {
			if (reset) {
				logSkip = 0;
				commits = [];
			}
			const data = await ws.http('git:log', { projectId, limit: 50, skip: logSkip });
			if (reset) {
				commits = data.commits;
			} else {
				commits = [...commits, ...data.commits];
			}
			logHasMore = data.hasMore;
			logSkip += data.commits.length;

			// Re-open a previously-selected commit detail for this project, once
			// its entry is present in the loaded log (lazy restore).
			if (pendingSelectedCommitHash) {
				const hash = pendingSelectedCommitHash;
				pendingSelectedCommitHash = null;
				if (commits.some(c => c.hash === hash)) {
					viewCommitDiff(hash);
				}
			}
		} catch (err) {
			debug.error('git', 'Failed to load log:', err);
		} finally {
			isLogLoading = false;
		}
	}

	async function loadConflicts() {
		if (!projectId) return;
		isConflictLoading = true;
		try {
			conflictFiles = await ws.http('git:conflict-files', { projectId });
		} catch (err) {
			debug.error('git', 'Failed to load conflicts:', err);
		} finally {
			isConflictLoading = false;
		}
	}

	// ============================
	// Staging Actions
	// ============================

	async function stageFile(path: string) {
		if (!projectId) return;
		try {
			await ws.http('git:stage', { projectId, filePath: path });
			await loadStatus();
			await migrateActiveTabAfterStatusChange(path);
		} catch (err) {
			debug.error('git', 'Failed to stage file:', err);
		}
	}

	async function handleRemoveRemote(name: string) {
		requestConfirm({
			title: 'Remove Remote',
			message: `Disconnect remote "${name}"? This will not delete the remote repository itself.`,
			type: 'warning',
			confirmText: 'Remove',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					await ws.http('git:remove-remote', { projectId, name });
					await loadRemotes();
				} catch (err) {
					debug.error('git', 'Failed to remove remote:', err);
				}
			}
		});
	}

	async function handleSaveRemote() {
		if (!projectId || !editingRemote || !editRemoteName.trim() || !editRemoteUrl.trim()) return;
		const oldName = editingRemote;
		const newName = editRemoteName.trim();
		const newUrl = editRemoteUrl.trim();
		savingRemote = true;
		try {
			await ws.http('git:edit-remote', { projectId, oldName, newName, newUrl });
			showInfo('Remote updated', `${oldName} → ${newName}`);
			editingRemote = null;
			editRemoteName = '';
			editRemoteUrl = '';
			await Promise.all([loadBranches(), loadRemotes()]);
		} catch (err) {
			debug.error('git', 'Failed to update remote:', err);
			showInfo('Update failed', (err as Error).message);
		} finally {
			savingRemote = false;
		}
	}

	// Mark a remote as the active one (drives branch ahead/behind, push target,
	// and the preferred clone/remote URL). Persisted via the selectedRemote effect.
	function setActiveRemote(name: string) {
		if (selectedRemote === name) return;
		selectedRemote = name;
		loadBranches(name);
	}

	async function handleFetchRemote(remote: string) {
		if (!projectId) return;
		fetchingRemote = remote;
		try {
			const result = await ws.http('git:fetch', { projectId, remote }) as { message: string };
			showInfo('Fetched', result.message);
			await loadBranches();
		} catch (err) {
			debug.error('git', 'Failed to fetch remote:', err);
		} finally {
			fetchingRemote = null;
		}
	}

	async function handleAddRemote() {
		if (!projectId || !newRemoteName.trim() || !newRemoteUrl.trim()) return;
		addingRemote = true;
		try {
			await ws.http('git:add-remote', { projectId, name: newRemoteName.trim(), url: newRemoteUrl.trim() });
			showInfo('Remote added', `${newRemoteName} → ${newRemoteUrl}`);
			newRemoteName = '';
			newRemoteUrl = '';
			showAddRemoteForm = false;
			await Promise.all([loadBranches(), loadRemotes()]);
		} catch (err) {
			debug.error('git', 'Failed to add remote:', err);
			showInfo('Add remote failed', (err as Error).message);
		} finally {
			addingRemote = false;
		}
	}

	async function handlePushBranch(branch: string) {
		if (!projectId) return;
		pushingBranch = branch;
		try {
			const result = await ws.http('git:push', { projectId, branch }) as { success: boolean; message: string };
			showInfo(result.success ? 'Pushed' : 'Push failed', result.message);
			await loadBranches();
		} catch (err) {
			debug.error('git', 'Failed to push branch:', err);
		} finally {
			pushingBranch = null;
		}
	}

	async function handleCherryPick(hash: string) {
		if (!projectId) return;
		try {
			const result = await ws.http('git:cherry-pick', { projectId, hashes: [hash] }) as { success: boolean; message: string };
			showInfo(result.success ? 'Cherry-picked' : 'Cherry-pick failed', result.message);
			if (result.success) {
				await loadBranches();
				await loadLog();
			}
		} catch (err) {
			debug.error('git', 'Failed to cherry-pick:', err);
		}
	}

	async function stageAll() {
		if (!projectId) return;
		try {
			await ws.http('git:stage-all', { projectId });
			await loadStatus();
			if (activeTab && activeTab.section !== 'commit') {
				await migrateActiveTabAfterStatusChange(activeTab.filePath);
			}
		} catch (err) {
			debug.error('git', 'Failed to stage all:', err);
		}
	}

	async function unstageFile(path: string) {
		if (!projectId) return;
		try {
			await ws.http('git:unstage', { projectId, filePath: path });
			await loadStatus();
			await migrateActiveTabAfterStatusChange(path);
		} catch (err) {
			debug.error('git', 'Failed to unstage file:', err);
		}
	}

	async function unstageAll() {
		if (!projectId) return;
		try {
			await ws.http('git:unstage-all', { projectId });
			await loadStatus();
			if (activeTab && activeTab.section !== 'commit') {
				await migrateActiveTabAfterStatusChange(activeTab.filePath);
			}
		} catch (err) {
			debug.error('git', 'Failed to unstage all:', err);
		}
	}

	async function discardFile(path: string) {
		const fileName = path.split(/[\\/]/).pop() || path;
		requestConfirm({
			title: 'Discard Changes',
			message: `Discard changes to "${fileName}"? This cannot be undone.`,
			type: 'error',
			confirmText: 'Discard',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					await ws.http('git:discard', { projectId, filePath: path });
					await loadStatus();
					await migrateActiveTabAfterStatusChange(path);
				} catch (err) {
					debug.error('git', 'Failed to discard file:', err);
				}
			}
		});
	}

	async function discardAll() {
		requestConfirm({
			title: 'Discard All Changes',
			message: 'Discard ALL changes? This cannot be undone.',
			type: 'error',
			confirmText: 'Discard All',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					await ws.http('git:discard-all', { projectId });
					await loadStatus();
					if (activeTab && activeTab.section !== 'commit') {
						await migrateActiveTabAfterStatusChange(activeTab.filePath);
					}
				} catch (err) {
					debug.error('git', 'Failed to discard all:', err);
				}
			}
		});
	}

	// ============================
	// Commit
	// ============================

	async function handleCommit(message: string) {
		if (!projectId) return;
		isCommitting = true;
		try {
			await ws.http('git:commit', { projectId, message });
			await loadAll();
			if (activeView === 'log') {
				await loadLog(true);
			}
		} catch (err) {
			debug.error('git', 'Commit failed:', err);
			showError('Commit Failed', err instanceof Error ? err.message : 'Unknown error');
		} finally {
			isCommitting = false;
		}
	}

	// ============================
	// Tab Operations
	// ============================

	function selectTab(id: string) {
		activeTabId = id;
		markGitUiDirty();
	}

	function closeTab(id: string) {
		const idx = openTabs.findIndex(t => t.id === id);
		if (idx === -1) return;
		openTabs = openTabs.filter(t => t.id !== id);
		if (activeTabId === id) {
			if (openTabs.length > 0) {
				const newIdx = Math.min(idx, openTabs.length - 1);
				activeTabId = openTabs[newIdx].id;
			} else {
				activeTabId = null;
				if (!isTwoColumnMode) viewMode = 'list';
			}
		}
		markGitUiDirty();
	}

	function closeAllTabs() {
		openTabs = [];
		activeTabId = null;
		if (!isTwoColumnMode) viewMode = 'list';
		markGitUiDirty();
	}

	// Drag-and-drop reorder state
	let dragSrcIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);

	function onTabDragStart(e: DragEvent, index: number) {
		dragSrcIndex = index;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(index));
		}
	}

	function onTabDragOver(e: DragEvent, index: number) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverIndex = index;
	}

	function onTabDragLeave() {
		dragOverIndex = null;
	}

	function onTabDrop(e: DragEvent, targetIndex: number) {
		e.preventDefault();
		const srcIdx = dragSrcIndex;
		dragSrcIndex = null;
		dragOverIndex = null;
		if (srcIdx === null || srcIdx === targetIndex) return;
		const newTabs = [...openTabs];
		const [moved] = newTabs.splice(srcIdx, 1);
		newTabs.splice(targetIndex, 0, moved);
		openTabs = newTabs;
	}

	function onTabDragEnd() {
		dragSrcIndex = null;
		dragOverIndex = null;
	}

	// After stage/unstage/discard, the active tab's file may have moved between
	// staged ⇄ unstaged or vanished entirely. Migrate it so the diff view stays
	// in sync instead of going blank.
	async function migrateActiveTabAfterStatusChange(filePath: string) {
		const tab = openTabs.find(t => t.filePath === filePath && t.id === activeTabId);
		if (!tab) return;
		if (tab.section === 'commit') return;

		const stagedFile = gitStatus.staged.find(f => f.path === filePath);
		const unstagedFile = gitStatus.unstaged.find(f => f.path === filePath);
		const untrackedFile = gitStatus.untracked.find(f => f.path === filePath);
		const conflictedFile = gitStatus.conflicted.find(f => f.path === filePath);

		if (!stagedFile && !unstagedFile && !untrackedFile && !conflictedFile) {
			openTabs = openTabs.filter(t => t.id !== tab.id);
			if (activeTabId === tab.id) {
				activeTabId = openTabs.length > 0 ? openTabs[openTabs.length - 1].id : null;
				if (!activeTabId && !isTwoColumnMode) viewMode = 'list';
			}
			return;
		}

		if (stagedFile) {
			await viewDiff(stagedFile, 'staged');
		} else if (unstagedFile) {
			await viewDiff(unstagedFile, 'unstaged');
		} else if (untrackedFile) {
			await viewDiff(untrackedFile, 'unstaged');
		} else if (conflictedFile) {
			await viewDiff(conflictedFile, 'conflicted');
		}
	}

	// Re-open the diff tab that was open before a refresh/switch, now that git
	// status is loaded. Only handles Changes-section tabs (staged/unstaged/
	// untracked/conflicted); commit-file tabs re-open from viewCommitDiff. The
	// tab is only restored while its section's view is the active one.
	function reopenPendingChangesDiff() {
		const pend = pendingActiveDiff;
		if (!pend || pend.section === 'commit') return;
		if (activeView !== 'changes') return;
		pendingActiveDiff = null;

		const path = pend.filePath;
		const top = pend.scrollTop ?? 0;
		const staged = gitStatus.staged.find(f => f.path === path);
		const unstaged = gitStatus.unstaged.find(f => f.path === path);
		const untracked = gitStatus.untracked.find(f => f.path === path);
		const conflicted = gitStatus.conflicted.find(f => f.path === path);

		// Prefer the persisted section if the file is still there; otherwise fall
		// back to wherever it currently lives, so a staged⇄unstaged move (or a new
		// untracked→tracked transition) since the last session still restores the
		// tab with a diff that matches the current git state. If the file is no
		// longer changed at all (committed/discarded), there is nothing to restore.
		if (pend.section === 'staged' && staged) return void viewDiff(staged, 'staged', top);
		if (pend.section === 'conflicted' && conflicted) return void viewDiff(conflicted, 'conflicted', top);
		if (staged) return void viewDiff(staged, 'staged', top);
		if (unstaged) return void viewDiff(unstaged, 'unstaged', top);
		if (untracked) return void viewDiff(untracked, 'unstaged', top);
		if (conflicted) return void viewDiff(conflicted, 'conflicted', top);
	}

	// ============================
	// Diff
	// ============================

	// Detect binary files by extension (for fallback when git diff returns empty)
	function isBinaryByExtension(filePath: string): boolean {
		const fileName = filePath.split(/[\\/]/).pop() || filePath;
		return isPreviewableFile(fileName) || isBinaryFile(fileName);
	}

	async function viewDiff(file: GitFileChange, section: string, restoreScrollTop = 0) {
		if (!projectId) return;
		const tabId = `${section}:${file.path}`;
		const fileName = file.path.split(/[\\/]/).pop() || file.path;
		const status = section === 'staged' ? file.indexStatus : file.workingStatus;

		// Changes view: always replace with single tab
		openTabs = [{
			id: tabId,
			filePath: file.path,
			fileName,
			section,
			diff: null,
			diffs: [],
			isLoading: true,
			status,
			scrollTop: restoreScrollTop
		}];
		activeTabId = tabId;
		if (!isTwoColumnMode) viewMode = 'diff';

		try {
			let diffResult: GitFileDiff | null = null;

			if (section === 'conflicted') {
				// Conflicted files have no meaningful staged/unstaged diff. Read the
				// working tree (which still contains <<<<<<< markers) and render it
				// as a single-side preview so the user can at least see the markers.
				const isBinary = isBinaryByExtension(file.path);
				if (isBinary) {
					diffResult = {
						oldPath: file.path,
						newPath: file.path,
						status: status || 'U',
						hunks: [],
						isBinary: true
					};
				} else {
					try {
						const basePath = projectState.currentProject?.path || '';
						const separator = basePath.includes('\\') ? '\\' : '/';
						const fullPath = `${basePath}${separator}${file.path}`;
						const fileData = await ws.http('files:read-file', { file_path: fullPath });
						if (fileData.isBinary) {
							diffResult = {
								oldPath: file.path,
								newPath: file.path,
								status: status || 'U',
								hunks: [],
								isBinary: true
							};
						} else {
							const lines = (fileData.content || '').split('\n');
							diffResult = {
								oldPath: file.path,
								newPath: file.path,
								status: status || 'U',
								hunks: [{
									oldStart: 0,
									oldLines: 0,
									newStart: 1,
									newLines: lines.length,
									header: `@@ -0,0 +1,${lines.length} @@`,
									lines: lines.map((line, i) => ({
										type: 'add' as const,
										content: line,
										newLineNumber: i + 1
									}))
								}],
								isBinary: false
							};
						}
					} catch (readErr) {
						debug.error('git', 'Failed to read conflicted file:', readErr);
						diffResult = null;
					}
				}
			} else if (status === '?') {
				// Untracked files have no git diff — read file content to build a synthetic diff
				const isBinary = isBinaryByExtension(file.path);
				if (isBinary) {
					diffResult = {
						oldPath: file.path,
						newPath: file.path,
						status: '?',
						hunks: [],
						isBinary: true
					};
				} else {
					const basePath = projectState.currentProject?.path || '';
					const separator = basePath.includes('\\') ? '\\' : '/';
					const fullPath = `${basePath}${separator}${file.path}`;
					const fileData = await ws.http('files:read-file', { file_path: fullPath });

					if (fileData.isBinary) {
						// Backend detected binary content — show preview instead of diff
						diffResult = {
							oldPath: file.path,
							newPath: file.path,
							status: '?',
							hunks: [],
							isBinary: true
						};
					} else {
						const lines = (fileData.content || '').split('\n');
						diffResult = {
							oldPath: file.path,
							newPath: file.path,
							status: '?',
							hunks: [{
								oldStart: 0,
								oldLines: 0,
								newStart: 1,
								newLines: lines.length,
								header: `@@ -0,0 +1,${lines.length} @@`,
								lines: lines.map((line, i) => ({
									type: 'add' as const,
									content: line,
									newLineNumber: i + 1
								}))
							}],
							isBinary: false
						};
					}
				}
			} else {
				const action = section === 'staged' ? 'git:diff-staged' : 'git:diff-unstaged';
				let diffs = await ws.http(action, { projectId, filePath: file.path });
				// A project switch / refresh can momentarily return an empty diff while
				// the backend settles right after the WS room change. Retry once before
				// falling back to an empty diff (which would render as a blank editor).
				if (diffs.length === 0) {
					await new Promise((r) => setTimeout(r, 150));
					diffs = await ws.http(action, { projectId, filePath: file.path });
				}
				diffResult = diffs.length > 0 ? diffs[0] : null;

				if (!diffResult) {
					diffResult = {
						oldPath: file.path,
						newPath: file.path,
						status: status || '?',
						hunks: [],
						isBinary: isBinaryByExtension(file.path)
					};
				} else if (status) {
					// Override diff parser status with authoritative status from git status
					// parseDiff defaults to 'M', but the real status (A, D, R, etc.) comes from git status
					diffResult = { ...diffResult, status };
				}
			}

			openTabs = openTabs.map(t =>
				t.id === tabId ? { ...t, diff: diffResult, isLoading: false } : t
			);
		} catch (err) {
			debug.error('git', 'Failed to load diff:', err);
			openTabs = openTabs.map(t =>
				t.id === tabId ? { ...t, diff: null, isLoading: false } : t
			);
		}
		// Remember the open diff tab per-project (server-persisted).
		markGitUiDirty();
	}

	async function viewCommitDiff(hash: string) {
		if (!projectId) return;
		const commit = commits.find(c => c.hash === hash);
		if (!commit) return;

		// Show the commit-detail file list in the left panel — diff tabs only
		// open when the user picks a specific file from that list.
		selectedCommit = {
			hash,
			hashShort: commit.hashShort,
			message: commit.message,
			author: commit.author,
			files: [],
			isLoading: true
		};
		// Remember the open commit detail per-project (server-persisted).
		markGitUiDirty();

		try {
			const diffs = await ws.http('git:diff-commit', { projectId, commitHash: hash });
			if (selectedCommit?.hash !== hash) return;
			selectedCommit = { ...selectedCommit, files: diffs, isLoading: false };

			// Re-open a previously-open commit-file diff tab for this project, now
			// that the commit's file list is available (lazy restore).
			const pend = pendingActiveDiff;
			if (pend && pend.section === 'commit' && pend.commitHash === hash) {
				pendingActiveDiff = null;
				const target = diffs.find(d => (d.newPath || d.oldPath) === pend.filePath);
				if (target) viewCommitFileDiff(target, pend.scrollTop ?? 0);
			}
		} catch (err) {
			debug.error('git', 'Failed to load commit diff:', err);
			if (selectedCommit?.hash === hash) {
				selectedCommit = { ...selectedCommit, isLoading: false };
			}
		}
	}

	function viewCommitFileDiff(file: GitFileDiff, restoreScrollTop = 0, commitHashOverride?: string) {
		const hash = commitHashOverride ?? selectedCommit?.hash;
		if (!hash) return;
		const path = file.newPath || file.oldPath;
		if (!path) return;
		const fileName = path.split(/[\\/]/).pop() || path;
		const tabId = `commit:${hash}:${path}`;

		openTabs = [{
			id: tabId,
			filePath: path,
			fileName,
			section: 'commit',
			diff: file,
			diffs: [],
			isLoading: false,
			commitHash: hash,
			status: file.status
		}];
		activeTabId = tabId;
		if (!isTwoColumnMode) viewMode = 'diff';
		// Remember the open commit-file diff tab per-project (server-persisted).
		markGitUiDirty();
	}

	function backToCommitList() {
		selectedCommit = null;
		markGitUiDirty();
	}

	// ============================
	// Branch Operations
	// ============================

	async function switchBranch(name: string) {
		if (!projectId) return;
		try {
			await ws.http('git:switch-branch', { projectId, name });
			await loadAll();
			if (activeView === 'log') await loadLog(true);
		} catch (err) {
			debug.error('git', 'Failed to switch branch:', err);
			showError('Switch Branch Failed', err instanceof Error ? err.message : 'Unknown error');
		}
	}

	function checkoutCommit(hash: string) {
		const commit = commits.find(item => item.hash === hash);
		const shortHash = commit?.hashShort ?? hash.slice(0, 7);
		requestConfirm({
			title: 'Checkout Commit',
			message: `Checkout commit ${shortHash}? This will detach HEAD. Create or switch to a branch before committing new work.`,
			type: 'warning',
			confirmText: 'Checkout',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					await ws.http('git:checkout-commit', { projectId, commitHash: hash });
					selectedCommit = null;
					openTabs = [];
					activeTabId = null;
					await loadAll();
					if (activeView === 'log') await loadLog(true);
					showInfo('Commit Checked Out', `Checked out ${shortHash}. HEAD is now detached.`);
				} catch (err) {
					debug.error('git', 'Failed to checkout commit:', err);
					showError('Checkout Failed', err instanceof Error ? err.message : 'Unknown error');
				}
			}
		});
	}

	function getPreferredRemoteUrl(): string | null {
		if (remotes.length === 0) return null;
		return remotes.find(remote => remote.name === selectedRemote)?.fetchUrl
			|| remotes.find(remote => remote.name === selectedRemote)?.pushUrl
			|| remotes[0]?.fetchUrl
			|| remotes[0]?.pushUrl
			|| null;
	}

	function buildRemoteCommitUrl(hash: string): string | null {
		const remoteUrl = getPreferredRemoteUrl();
		if (!remoteUrl) return null;

		let normalized = remoteUrl.trim();

		if (normalized.startsWith('git@')) {
			normalized = normalized.replace(/^git@([^:]+):/, 'https://$1/');
		} else if (normalized.startsWith('ssh://git@')) {
			normalized = normalized.replace(/^ssh:\/\/git@/, 'https://');
		} else if (normalized.startsWith('ssh://')) {
			normalized = normalized.replace(/^ssh:\/\//, 'https://');
		}

		normalized = normalized.replace(/\.git$/, '').replace(/\/+$/, '');

		try {
			const url = new URL(normalized);
			const basePath = url.pathname.replace(/\/+$/, '');
			const commitSegment = url.hostname.includes('bitbucket') ? 'commits' : 'commit';
			return `${url.protocol}//${url.host}${basePath}/${commitSegment}/${hash}`;
		} catch {
			return null;
		}
	}

	async function handleCreateBranchFromForm() {
		if (!projectId || !newBranchName.trim()) return;
		const success = await createBranch(newBranchName.trim());
		if (success) { newBranchName = ''; showCreateBranchForm = false; }
	}

	async function checkoutRemoteBranch(remoteBranch: string) {
		const parts = remoteBranch.split('/');
		const localName = parts.slice(1).join('/');
		await switchBranch(localName);
	}

	function getBranchRemote(branch: GitBranch): string | null {
		return branch.upstream?.split('/')[0] || remotes.find(remote => branch.upstream?.startsWith(remote.name + '/'))?.name || null;
	}

	function getBranchRemoteName(branch: GitBranch): string | null {
		if (!branch.upstream) return null;
		const remoteName = getBranchRemote(branch);
		return remoteName ? branch.upstream.slice(remoteName.length + 1) : branch.upstream;
	}

	const BRANCH_COMMIT_PAGE_SIZE = 8;

	async function loadBranchCommits(branchName: string, reset = false) {
		if (!projectId) return;
		const current = branchCommitState[branchName] ?? { commits: [], isLoading: false, hasMore: true, skip: 0 };
		if (current.isLoading) return;
		const skip = reset ? 0 : current.skip;
		branchCommitState = { ...branchCommitState, [branchName]: { ...current, isLoading: true } };
		try {
			const result = await ws.http('git:log', { projectId, branch: branchName, limit: BRANCH_COMMIT_PAGE_SIZE, skip });
			branchCommitState = { ...branchCommitState, [branchName]: { commits: reset ? result.commits : [...current.commits, ...result.commits], isLoading: false, hasMore: result.hasMore, skip: skip + result.commits.length } };
		} catch { branchCommitState = { ...branchCommitState, [branchName]: { ...current, isLoading: false } }; }
	}

	function toggleBranchExpanded(branchName: string) {
		const next = new Set(expandedBranches);
		if (next.has(branchName)) { next.delete(branchName); expandedBranches = next; branchCommitState = { ...branchCommitState, [branchName]: { commits: [], isLoading: false, hasMore: true, skip: 0 } }; return; }
		next.add(branchName); expandedBranches = next;
		if (!branchCommitState[branchName]?.commits.length) { void loadBranchCommits(branchName, true); }
	}

	async function loadBranchCommitFiles(hash: string) {
		if (!projectId) return;
		const current = branchCommitFileState[hash] ?? { files: [], isLoading: false };
		if (current.isLoading) return;
		branchCommitFileState = { ...branchCommitFileState, [hash]: { ...current, isLoading: true } };
		try {
			const files = await ws.http('git:diff-commit', { projectId, commitHash: hash });
			branchCommitFileState = { ...branchCommitFileState, [hash]: { files, isLoading: false } };
		} catch { branchCommitFileState = { ...branchCommitFileState, [hash]: { ...current, isLoading: false } }; }
	}

	function toggleBranchCommitExpanded(hash: string) {
		const next = new Set(expandedBranchCommits);
		if (next.has(hash)) { next.delete(hash); expandedBranchCommits = next; return; }
		next.add(hash); expandedBranchCommits = next;
		if (!branchCommitFileState[hash]?.files.length) { void loadBranchCommitFiles(hash); }
	}

	async function loadContributors() {
		if (!projectId || isContributorsLoading) return;
		isContributorsLoading = true;
		try {
		const data = await ws.http('git:log', { projectId, limit: 500, skip: 0 });
			const map = new Map<string, { name: string; email: string; count: number }>();
			for (const c of data.commits) {
				// Group by email when available (one person may commit under several
				// display names) and fall back to the author name otherwise.
				const key = (c.authorEmail || c.author).toLowerCase().trim();
				const existing = map.get(key);
				if (existing) { existing.count++; } else { map.set(key, { name: c.author.trim(), email: c.authorEmail, count: 1 }); }
			}
			contributors = [...map.values()].sort((a, b) => b.count - a.count);
		} catch { /* ignore */ }
		finally { isContributorsLoading = false; }
	}

	async function createBranch(name: string): Promise<boolean> {
		if (!projectId) return false;
		try {
			await ws.http('git:create-branch', { projectId, name });
			showInfo('Branch Created', `Switched to "${name}".`);
			await loadAll();
			return true;
		} catch (err) {
			debug.error('git', 'Failed to create branch:', err);
			showError('Create Branch Failed', err instanceof Error ? err.message : 'Unknown error');
			return false;
		}
	}

	async function deleteBranch(name: string) {
		requestConfirm({
			title: 'Delete Branch',
			message: `Delete branch "${name}"?`,
			type: 'error',
			confirmText: 'Delete',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					await ws.http('git:delete-branch', { projectId, name });
					await loadBranches();
				} catch (err) {
					debug.error('git', 'Failed to delete branch:', err);
					requestConfirm({
						title: 'Force Delete Branch',
						message: 'Branch is not fully merged. Force delete?',
						type: 'error',
						confirmText: 'Force Delete',
						onConfirm: async () => {
							try {
								await ws.http('git:delete-branch', { projectId, name, force: true });
			await Promise.all([loadBranches(), loadRemotes()]);
							} catch (forceErr) {
								showError('Force Delete Failed', forceErr instanceof Error ? forceErr.message : 'Unknown error');
							}
						}
					});
				}
			}
		});
	}

	async function openMergeBranchModal() {
		if (blockedWhileBusy('merge')) return;
		const latestBranchInfo = await loadBranches();
		const latestMergeableBranches = latestBranchInfo?.local.filter(branch => !branch.isCurrent) ?? [];
		if (latestMergeableBranches.length === 0) {
			showError('Merge Branch Unavailable', 'No other local branches are available to merge.');
			return;
		}
		mergeBranchName = latestMergeableBranches.find(branch => branch.name === mergeBranchName)?.name
			?? latestMergeableBranches[0]?.name
			?? '';
		mergeMode = 'default';
		showMergeBranchModal = true;
	}

	function closeMergeBranchModal() {
		showMergeBranchModal = false;
		mergeMode = 'default';
	}

	async function runMergeBranch(name: string, noFastForward = false) {
		if (!projectId || !name || isMoreBusy) return;
		if (blockedWhileBusy('merge')) return;

		const targetBranch = branchInfo?.current;
		await runMore(async () => {
			try {
				const result = await ws.http('git:merge-branch', {
					projectId,
					branchName: name,
					noFastForward
				});
				showMergeBranchModal = false;

				if (!result.success) {
					await loadAll();
					if (gitStatus.conflicted.length > 0) {
						await loadConflicts();
						showConflictResolver = true;
					} else {
						showError('Merge Failed', result.message);
					}
				} else {
					await loadAll();
					showInfo(
						'Merge Complete',
						`Merged "${name}" into "${targetBranch ?? 'current branch'}"${noFastForward ? ' with --no-ff' : ''}.`
					);
				}
			} catch (err) {
				debug.error('git', 'Failed to merge branch:', err);
				showError('Merge Failed', err instanceof Error ? err.message : 'Unknown error');
			}
		});
	}

	function mergeBranch(name: string) {
		if (blockedWhileBusy('merge')) return;
		requestConfirm({
			title: 'Merge Branch',
			message: `Merge "${name}" into "${branchInfo?.current}"?`,
			type: 'info',
			confirmText: 'Merge',
			onConfirm: () => void runMergeBranch(name, false)
		});
	}

	// ============================
	// Remote Operations
	// ============================

	let isFetching = $state(false);
	let isPulling = $state(false);
	let isPushing = $state(false);
	let isMoreBusy = $state(false);

	async function handleFetch() {
		if (!projectId || isFetching) return;
		isFetching = true;
		try {
			const prevAhead = branchInfo?.ahead ?? 0;
			const prevBehind = branchInfo?.behind ?? 0;
			await ws.http('git:fetch', { projectId, remote: selectedRemote });
			await loadBranches();
			const newAhead = branchInfo?.ahead ?? 0;
			const newBehind = branchInfo?.behind ?? 0;
			const parts: string[] = [];
			if (newAhead > 0) parts.push(`${newAhead} ahead`);
			if (newBehind > 0) parts.push(`${newBehind} behind`);
			if (parts.length > 0) {
				showInfo('Fetch Complete', `Your branch is ${parts.join(', ')} ${selectedRemote}.`);
			} else if (prevBehind > 0 || prevAhead > 0) {
				showInfo('Fetch Complete', `In sync with ${selectedRemote}.`);
			} else {
				showInfo('Fetch Complete', `Already up to date with ${selectedRemote}.`);
			}
		} catch (err) {
			debug.error('git', 'Fetch failed:', err);
			showError('Fetch Failed', err instanceof Error ? err.message : 'Unknown error');
		} finally {
			isFetching = false;
		}
	}

	async function handlePull() {
		if (!projectId || isPulling) return;
		if (blockedWhileBusy('pull')) return;
		isPulling = true;
		try {
			const prevBehind = branchInfo?.behind ?? 0;
			const result = await ws.http('git:pull', { projectId, remote: selectedRemote, branch: branchInfo?.current });
			if (!result.success) {
				if (result.message.includes('conflict')) {
					await loadAll();
					await loadConflicts();
					showConflictResolver = true;
				} else {
					showError('Pull Failed', result.message);
				}
			} else {
				await loadAll();
				if (prevBehind > 0) {
					showInfo('Pull Complete', `Pulled ${prevBehind} commit${prevBehind > 1 ? 's' : ''} from ${selectedRemote}.`);
				} else {
					showInfo('Pull Complete', `Already up to date with ${selectedRemote}.`);
				}
			}
		} catch (err) {
			debug.error('git', 'Pull failed:', err);
			showError('Pull Failed', err instanceof Error ? err.message : 'Unknown error');
		} finally {
			isPulling = false;
		}
	}

	async function handlePush() {
		if (!projectId || isPushing) return;
		if (blockedWhileBusy('push')) return;
		isPushing = true;
		try {
			const prevAhead = branchInfo?.ahead ?? 0;
			const result = await ws.http('git:push', { projectId, remote: selectedRemote, branch: branchInfo?.current });
			if (!result.success) {
				showError('Push Failed', result.message);
			} else {
				await loadBranches();
				if (prevAhead > 0) {
					showInfo('Push Complete', `Pushed ${prevAhead} commit${prevAhead > 1 ? 's' : ''} to ${selectedRemote}.`);
				} else {
					showInfo('Push Complete', `Branch pushed to ${selectedRemote}.`);
				}
			}
		} catch (err) {
			debug.error('git', 'Push failed:', err);
			showError('Push Failed', err instanceof Error ? err.message : 'Unknown error');
		} finally {
			isPushing = false;
		}
	}

	// ============================
	// More Git Actions (push variants, undo, npm version, maintenance)
	// ============================

	async function runMore(fn: () => Promise<void>) {
		if (!projectId || isMoreBusy) return;
		isMoreBusy = true;
		try {
			await fn();
		} finally {
			isMoreBusy = false;
		}
	}

	async function pushVariant(mode: 'with-tags' | 'all-tags' | 'force-lease' | 'force', label: string) {
		if (blockedWhileBusy('push')) return;
		await runMore(async () => {
			try {
				const result = await ws.http('git:push-advanced', {
					projectId,
					mode,
					remote: selectedRemote,
					branch: branchInfo?.current
				});
				if (!result.success) {
					showError('Push Failed', result.message);
				} else {
					await loadBranches();
					await loadTags();
					showInfo('Push Complete', `${label} to ${selectedRemote}.`);
				}
			} catch (err) {
				debug.error('git', 'Push variant failed:', err);
				showError('Push Failed', err instanceof Error ? err.message : 'Unknown error');
			}
		});
	}

	async function pullRebase() {
		if (blockedWhileBusy('pull with rebase')) return;
		await runMore(async () => {
			try {
				const result = await ws.http('git:pull', {
					projectId,
					remote: selectedRemote,
					branch: branchInfo?.current,
					rebase: true
				});
				if (!result.success) {
					if (result.message.includes('conflict')) {
						await loadAll();
						await loadConflicts();
						showConflictResolver = true;
					} else {
						showError('Pull Failed', result.message);
					}
				} else {
					await loadAll();
					showInfo('Pull Complete', `Rebased onto ${selectedRemote}.`);
				}
			} catch (err) {
				debug.error('git', 'Pull (rebase) failed:', err);
				showError('Pull Failed', err instanceof Error ? err.message : 'Unknown error');
			}
		});
	}

	async function fetchAll() {
		await runMore(async () => {
			try {
				await ws.http('git:fetch-all', { projectId });
				await loadBranches();
				await loadTags();
				showInfo('Fetch Complete', 'Fetched all remotes and pruned stale branches.');
			} catch (err) {
				debug.error('git', 'Fetch all failed:', err);
				showError('Fetch Failed', err instanceof Error ? err.message : 'Unknown error');
			}
		});
	}

	async function undoCommit(mode: 'soft' | 'mixed' | 'hard') {
		await runMore(async () => {
			try {
				await ws.http('git:undo-commit', { projectId, mode });
				await loadAll();
				if (activeView === 'log') await loadLog(true);
				const detail =
					mode === 'soft'
						? 'Changes kept staged.'
						: mode === 'mixed'
							? 'Changes kept in working tree.'
							: 'Changes discarded.';
				showInfo('Commit Undone', detail);
			} catch (err) {
				debug.error('git', 'Undo commit failed:', err);
				showError('Undo Failed', err instanceof Error ? err.message : 'Unknown error');
			}
		});
	}

	async function revertLast() {
		await runMore(async () => {
			try {
				const result = await ws.http('git:revert', { projectId });
				if (!result.success) {
					if (gitStatus.conflicted.length > 0 || result.message.includes('conflict')) {
						await loadAll();
						await loadConflicts();
						showConflictResolver = true;
					} else {
						showError('Revert Failed', result.message);
					}
				} else {
					await loadAll();
					if (activeView === 'log') await loadLog(true);
					showInfo('Commit Reverted', 'Created a new commit that undoes the last one.');
				}
			} catch (err) {
				debug.error('git', 'Revert failed:', err);
				showError('Revert Failed', err instanceof Error ? err.message : 'Unknown error');
			}
		});
	}

	async function npmVersion(bump: 'patch' | 'minor' | 'major') {
		await runMore(async () => {
			try {
				const result = await ws.http('git:npm-version', { projectId, bump });
				if (!result.success) {
					showError('npm version Failed', result.message);
				} else {
					await loadAll();
					if (activeView === 'log') await loadLog(true);
					showInfo('Version Bumped', `Package is now ${result.version}.`);
				}
			} catch (err) {
				debug.error('git', 'npm version failed:', err);
				showError('npm version Failed', err instanceof Error ? err.message : 'Unknown error');
			}
		});
	}

	async function cleanUntracked() {
		await runMore(async () => {
			try {
				await ws.http('git:clean', { projectId });
				await loadStatus();
				showInfo('Clean Complete', 'Removed untracked files.');
			} catch (err) {
				debug.error('git', 'Clean failed:', err);
				showError('Clean Failed', err instanceof Error ? err.message : 'Unknown error');
			}
		});
	}

	async function optimizeRepo() {
		await runMore(async () => {
			try {
				await ws.http('git:gc', { projectId });
				showInfo('Optimized', 'Repository garbage collection complete.');
			} catch (err) {
				debug.error('git', 'Optimize failed:', err);
				showError('Optimize Failed', err instanceof Error ? err.message : 'Unknown error');
			}
		});
	}

	function handleMoreAction(action: GitMoreAction) {
		switch (action) {
			case 'merge-branch':
				return void openMergeBranchModal();
			case 'push-follow-tags':
				return void pushVariant('with-tags', 'Pushed branch with tags');
			case 'push-all-tags':
				return void pushVariant('all-tags', 'Pushed all tags');
			case 'push-force-lease':
				return requestConfirm({
					title: 'Force Push (with lease)',
					message: `Force push "${branchInfo?.current}" to ${selectedRemote}? This overwrites the remote branch but aborts if someone else has pushed.`,
					type: 'warning',
					confirmText: 'Force Push',
					onConfirm: () => void pushVariant('force-lease', 'Force-pushed branch')
				});
			case 'push-force':
				return requestConfirm({
					title: 'Force Push',
					message: `Force push "${branchInfo?.current}" to ${selectedRemote}? This unconditionally overwrites the remote branch and can destroy others' commits.`,
					type: 'error',
					confirmText: 'Force Push',
					onConfirm: () => void pushVariant('force', 'Force-pushed branch')
				});
			case 'pull-rebase':
				return void pullRebase();
			case 'fetch-all':
				return void fetchAll();
			case 'undo-soft':
				return void undoCommit('soft');
			case 'undo-mixed':
				return void undoCommit('mixed');
			case 'undo-hard':
				return requestConfirm({
					title: 'Undo Last Commit (discard)',
					message: 'Undo the last commit and discard all its changes? This cannot be undone.',
					type: 'error',
					confirmText: 'Discard',
					onConfirm: () => void undoCommit('hard')
				});
			case 'revert-last':
				return void revertLast();
			case 'npm-patch':
			case 'npm-minor':
			case 'npm-major': {
				const bump = action.replace('npm-', '') as 'patch' | 'minor' | 'major';
				return requestConfirm({
					title: `npm version ${bump}`,
					message: `Bump the package version (${bump}) and create a version commit and tag? Requires a clean working tree.`,
					type: 'info',
					confirmText: 'Bump Version',
					onConfirm: () => void npmVersion(bump)
				});
			}
			case 'clean-untracked':
				return requestConfirm({
					title: 'Clean Untracked Files',
					message: 'Permanently delete all untracked files and directories? This cannot be undone.',
					type: 'error',
					confirmText: 'Clean',
					onConfirm: () => void cleanUntracked()
				});
			case 'gc':
				return void optimizeRepo();
		}
	}

	// ============================
	// Conflict Resolution
	// ============================

	async function resolveConflict(filePath: string, resolution: 'ours' | 'theirs' | 'custom', customContent?: string) {
		if (!projectId) return;
		try {
			await ws.http('git:resolve-conflict', { projectId, filePath, resolution, customContent });
			await loadConflicts();
			await loadStatus();
			if (conflictFiles.length === 0) {
				showConflictResolver = false;
			}
		} catch (err) {
			debug.error('git', 'Failed to resolve conflict:', err);
		}
	}

	function buildAIPromptForFile(file: GitConflictFile): string {
		const lang = detectLanguageFromFilename(file.path);
		const count = file.markers.length;
		return `Please help me resolve the merge conflict${count === 1 ? '' : 's'} in \`${file.path}\`. Analyze the conflict${count === 1 ? '' : 's'} and edit the file directly using your tools to apply the resolution, then stage it with \`git add\`.

The file currently has ${count} conflict marker${count === 1 ? '' : 's'}:

\`\`\`${lang}
${file.content}
\`\`\``;
	}

	async function resolveWithAI(filePath: string) {
		const file = conflictFiles.find((f) => f.path === filePath);
		if (!file) return;
		const prompt = buildAIPromptForFile(file);
		showConflictResolver = false;
		showPanel('chat');
		try {
			await chatService.sendMessage(prompt);
		} catch (err) {
			debug.error('git', 'Failed to send AI conflict resolution prompt:', err);
			showError(
				'AI Resolution Failed',
				err instanceof Error ? err.message : 'Could not send conflict to chat.'
			);
		}
	}

	async function resolveAllWithAI() {
		if (conflictFiles.length === 0) return;
		const summary = conflictFiles
			.map(
				(f, i) =>
					`${i + 1}. \`${f.path}\` (${f.markers.length} conflict${f.markers.length === 1 ? '' : 's'})`
			)
			.join('\n');
		const bodies = conflictFiles
			.map((f) => {
				const lang = detectLanguageFromFilename(f.path);
				return `### \`${f.path}\`\n\n\`\`\`${lang}\n${f.content}\n\`\`\``;
			})
			.join('\n\n');
		const prompt = `Please help me resolve merge conflicts in these files. For each file, analyze the conflicts, edit the file directly using your tools to apply the resolution, then stage each one with \`git add\`.

${summary}

${bodies}`;
		showConflictResolver = false;
		showPanel('chat');
		try {
			await chatService.sendMessage(prompt);
		} catch (err) {
			debug.error('git', 'Failed to send AI bulk conflict resolution prompt:', err);
			showError(
				'AI Resolution Failed',
				err instanceof Error ? err.message : 'Could not send conflicts to chat.'
			);
		}
	}

	async function abortMerge() {
		requestConfirm({
			title: 'Abort Merge',
			message: 'Abort the current merge? All conflict resolutions will be lost.',
			type: 'error',
			confirmText: 'Abort Merge',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					await ws.http('git:abort-merge', { projectId });
					showConflictResolver = false;
					await loadAll();
				} catch (err) {
					debug.error('git', 'Failed to abort merge:', err);
				}
			}
		});
	}

	function openConflictResolver(path: string) {
		conflictInitialPath = path;
		loadConflicts().then(() => {
			showConflictResolver = true;
		});
	}

	// ============================
	// Stash Operations
	// ============================

	async function loadStash() {
		if (!projectId) return;
		isStashLoading = true;
		try {
			stashEntries = await ws.http('git:stash-list', { projectId });
		} catch (err) {
			debug.error('git', 'Failed to load stash list:', err);
		} finally {
			isStashLoading = false;
		}
	}

	async function handleStashSave() {
		if (!projectId) return;
		try {
			await ws.http('git:stash-save', { projectId, message: stashMessage.trim() || undefined });
			stashMessage = '';
			showStashSaveForm = false;
			await Promise.all([loadStash(), loadStatus()]);
		} catch (err) {
			debug.error('git', 'Stash save failed:', err);
			showError('Stash Failed', err instanceof Error ? err.message : 'Unknown error');
		}
	}

	/**
	 * Triggered by the stash icon in the Staged/Changes section headers.
	 * Jumps to the More → Stash sub-tab, opens the stash-save form, and
	 * focuses the message input so the user can type a description and submit.
	 */
	function openStashPrompt() {
		stashMessage = '';
		showStashSaveForm = true;
		moreSubTab = 'stash';
		switchToView('more');
		// Focus the message input after Svelte paints the form. Using
		// rAF + small delay because the panel may need to switch/scroll
		// before the input is visible and focusable.
		requestAnimationFrame(() => {
			setTimeout(() => {
				const el = document.querySelector<HTMLInputElement>('[data-stash-message-input]');
				el?.focus();
				el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
			}, 50);
		});
	}

	async function handleStashPop(index: number) {
		if (!projectId) return;
		try {
			const result = await ws.http('git:stash-pop', { projectId, index });
			await Promise.all([loadStash(), loadStatus()]);
			if (!result.success && result.hasConflicts) {
				await loadConflicts();
				const count = conflictFiles.length;
				showError(
					'Stash Pop — Conflicts',
					`Applied the stash but ${count} file${count === 1 ? '' : 's'} ${count === 1 ? 'has' : 'have'} conflicts. Opening the resolver — the stash is still saved in case you need to abort.`
				);
				conflictInitialPath = conflictFiles[0]?.path ?? null;
				showConflictResolver = true;
			} else if (result.success) {
				showInfo('Stash Applied', 'Stash popped successfully.');
			}
		} catch (err) {
			debug.error('git', 'Stash pop failed:', err);
			const msg = err instanceof Error ? err.message : 'Unknown error';
			showError('Stash Pop Failed', msg.replace(/^git stash pop failed:\s*/i, '').trim() || msg);
		}
	}

	async function handleStashDrop(index: number) {
		requestConfirm({
			title: 'Drop Stash',
			message: `Drop stash@{${index}}? This cannot be undone.`,
			type: 'error',
			confirmText: 'Drop',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					await ws.http('git:stash-drop', { projectId, index });
					await loadStash();
				} catch (err) {
					debug.error('git', 'Stash drop failed:', err);
					showError('Stash Drop Failed', err instanceof Error ? err.message : 'Unknown error');
				}
			}
		});
	}

	/**
	 * Format an ISO date string as a compact relative time (e.g. "2h ago",
	 * "3d ago"). Mirrors the helper used in HistoryView / HistoryModal so
	 * the user sees the same wording in the source control and history
	 * views. Used for both stash entries and branch last-commit dates.
	 */
	function formatRelativeTime(iso: string | undefined): string {
		if (!iso) return '';
		const date = new Date(iso).getTime();
		if (Number.isNaN(date)) return '';
		const diffMs = Date.now() - date;
		const diffMins = Math.floor(diffMs / 1000 / 60);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);
		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
		if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
		return `${Math.floor(diffDays / 365)}y ago`;
	}

	async function loadStashFiles(index: number) {
		if (!projectId) return;
		stashFileState = { ...stashFileState, [index]: { files: stashFileState[index]?.files ?? [], isLoading: true } };
		try {
			const diffs = await ws.http('git:stash-diff', { projectId, index });
			stashFileState = { ...stashFileState, [index]: { files: diffs, isLoading: false } };
		} catch (err) {
			debug.error('git', 'Failed to load stash diff:', err);
			stashFileState = { ...stashFileState, [index]: { files: [], isLoading: false } };
		}
	}

	function toggleStashExpanded(index: number) {
		const next = new Set(expandedStashes);
		if (next.has(index)) {
			next.delete(index);
		} else {
			next.add(index);
			if (!stashFileState[index]?.files.length) void loadStashFiles(index);
		}
		expandedStashes = next;
	}

	/** Open a single file from a stash in the diff editor. */
	function viewStashFileDiff(file: GitFileDiff, index: number) {
		const path = file.newPath || file.oldPath;
		if (!path) return;
		const fileName = path.split(/[\\/]/).pop() || path;
		const tabId = `stash:${index}:${path}`;
		openTabs = [{
			id: tabId,
			filePath: path,
			fileName,
			section: 'stash',
			diff: file,
			diffs: [],
			isLoading: false,
			status: file.status
		}];
		activeTabId = tabId;
		if (!isTwoColumnMode) viewMode = 'diff';
		markGitUiDirty();
	}

	// ============================
	// Tag Operations
	// ============================

	async function loadTags() {
		if (!projectId) return;
		isTagsLoading = true;
		try {
			tags = await ws.http('git:tags', { projectId });
		} catch (err) {
			debug.error('git', 'Failed to load tags:', err);
		} finally {
			isTagsLoading = false;
		}
	}

	async function handleCreateTag() {
		if (!projectId || !newTagName.trim()) return;
		try {
			await ws.http('git:create-tag', {
				projectId,
				name: newTagName.trim(),
				message: newTagMessage.trim() || undefined
			});
			newTagName = '';
			newTagMessage = '';
			showCreateTagForm = false;
			await loadTags();
		} catch (err) {
			debug.error('git', 'Create tag failed:', err);
			showError('Create Tag Failed', err instanceof Error ? err.message : 'Unknown error');
		}
	}

	async function handleDeleteTag(name: string) {
		requestConfirm({
			title: 'Delete Tag',
			message: `Delete tag "${name}"?`,
			type: 'error',
			confirmText: 'Delete',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					await ws.http('git:delete-tag', { projectId, name });
					await loadTags();
				} catch (err) {
					debug.error('git', 'Delete tag failed:', err);
					showError('Delete Tag Failed', err instanceof Error ? err.message : 'Unknown error');
				}
			}
		});
	}

	async function handlePushTag(name: string) {
		if (!projectId) return;
		try {
			const result = await ws.http('git:push-tag', { projectId, name });
			if (!result.success) {
				showError('Push Tag Failed', result.message);
			} else {
				showInfo('Tag Pushed', `Tag "${name}" pushed to remote.`);
			}
		} catch (err) {
			debug.error('git', 'Push tag failed:', err);
			showError('Push Tag Failed', err instanceof Error ? err.message : 'Unknown error');
		}
	}

	async function copyTagHash(hash: string, e: MouseEvent) {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(hash);
			showInfo('Copied', `Hash ${hash.substring(0, 7)} copied to clipboard`);
		} catch {
			showError('Copy Failed', 'Could not copy to clipboard');
		}
	}

	// ============================
	// Lifecycle
	// ============================

	$effect(() => {
		if (hasActiveProject && projectId) {
			const prevId = untrack(() => lastProjectId);
			if (projectId !== prevId) {
				untrack(() => {
					lastProjectId = projectId;

					// Heavy data (open diffs, history) is always re-fetched lazily.
					resetAllViewTabs();
					commits = [];
					logSkip = 0;
					selectedCommit = null;

					// Restore this project's view. Persistence of the LEAVING project
					// is handled by the workspace coordinator (snapshot provider +
					// flush-before-switch), so we ONLY restore here — never save the
					// already-cleared draft (that previously clobbered it).
					const restored = loadGitUiState(projectId);
					if (restored) {
						activeView = restored.activeView;
						leftPanelWidth = restored.leftPanelWidth;
						selectedRemote = restored.selectedRemote;
						gitDraft.commitMessage = restored.commitMessage;
						pendingSelectedCommitHash = restored.selectedCommitHash;
						pendingActiveDiff = restored.activeDiff;
					} else {
						activeView = 'changes';
						selectedRemote = 'origin';
						gitDraft.commitMessage = '';
						pendingSelectedCommitHash = null;
						pendingActiveDiff = null;
					}

					// Once git status is loaded (isRepo known), re-open the restored
					// diff tab and load the data behind the restored view. We do this
					// explicitly rather than leaning solely on the reactive view
					// effects, which can miss the isRepo flip during a busy switch and
					// leave History stuck on "No commits yet".
					loadAll().then(() => {
						if (!isRepo) return;
						reopenPendingChangesDiff();
						if (activeView === 'log' && commits.length === 0) loadLog(true);
					});
				});
			}
		}
	});

	// Expose live git view state to the workspace coordinator for server saves.
	$effect(() => {
		const provider = (): GitUiState => ({
			activeView,
			leftPanelWidth,
			selectedRemote,
			commitMessage: gitDraft.commitMessage,
			selectedCommitHash: selectedCommit?.hash ?? null,
			activeDiff: activeTab
				? {
					section: activeTab.section,
					filePath: activeTab.filePath,
					commitHash: activeTab.commitHash,
					scrollTop: activeDiffScrollTop()
				}
				: null
		});
		setGitSnapshotProvider(provider);
		return () => {
			// Persist the live view into the in-session cache before detaching, so a
			// panel swap (which unmounts this component) restores the active tab/diff
			// on remount rather than resetting to the activation-time slice.
			captureActiveGitUiState();
			setGitSnapshotProvider(null);
		};
	});

	// Load log when switching to log view
	$effect(() => {
		if (activeView === 'log' && isRepo) {
			untrack(() => {
				if (commits.length === 0) {
					loadLog(true);
				}
			});
		}
	});



	// Refresh branch list when switching to Branches view
	$effect(() => {
		if (activeView === 'branches' && isRepo) {
			untrack(() => loadBranches());
		}
	});

	// Refresh the active More sub-tab's data when shown
	$effect(() => {
		if (activeView !== 'more' || !isRepo) return;
		const sub = moreSubTab;
		untrack(() => {
			if (sub === 'tags') loadTags();
			else if (sub === 'stash') loadStash();
			else if (sub === 'contributors') loadContributors();
		});
	});

	// Sync view mode on column mode change
	let prevTwoColumnMode = $state<boolean | null>(null);
	$effect(() => {
		if (prevTwoColumnMode !== null && prevTwoColumnMode !== isTwoColumnMode) {
			if (!isTwoColumnMode) {
				if (activeTabId && openTabs.length > 0) {
					viewMode = 'diff';
				} else {
					viewMode = 'list';
				}
			}
		}
		prevTwoColumnMode = isTwoColumnMode;
	});

	// Keep the project watched while this panel is mounted. Routed through the
	// shared client-side ref-count so watch/unwatch stays balanced with the
	// Files dock (both share one connection); releasing here only stops the
	// watcher if no other panel still holds it.
	$effect(() => {
		const path = projectState.currentProject?.path;
		if (hasActiveProject && projectId && path) {
			const release = acquireFileWatch(path);
			return release;
		}
	});

	// Debounce timer for file/git change events
	let changeDebounce: ReturnType<typeof setTimeout> | null = null;

	// Shared refresh logic for both file changes and git state changes
	function scheduleGitRefresh() {
		if (changeDebounce) clearTimeout(changeDebounce);
		changeDebounce = setTimeout(async () => {
			changeDebounce = null;
			// Refresh git status and branches (branch switch also modifies working tree)
			const prevBranch = branchInfo?.current;
			await Promise.all([loadStatus(), loadBranches()]);

			// If branch changed, also refresh remotes
			if (branchInfo?.current !== prevBranch) {
				loadRemotes();
			}

			// Refresh the active diff tab if currently viewing one. The file may
			// have moved between staged/unstaged/untracked since the last view —
			// migrate the section so we don't render an empty diff.
			if (activeTab && !activeTab.isLoading && activeTab.section !== 'commit') {
				await migrateActiveTabAfterStatusChange(activeTab.filePath);
			}
		}, 400);
	}

	// Subscribe to file change events (working tree changes)
	$effect(() => {
		if (!hasActiveProject || !projectId) return;

		const unsub = ws.on('files:changed', (payload: any) => {
			if (payload.projectId !== projectId || !isRepo) return;
			scheduleGitRefresh();
		});

		return () => {
			unsub();
			if (changeDebounce) {
				clearTimeout(changeDebounce);
				changeDebounce = null;
			}
		};
	});

	// Subscribe to git state change events (external git add, commit, branch switch, etc.)
	$effect(() => {
		if (!hasActiveProject || !projectId) return;

		const unsub = ws.on('git:changed', (payload: any) => {
			if (payload.projectId !== projectId || !isRepo) return;
			scheduleGitRefresh();
			// Refresh branches and remotes in case of branch switch/create/delete
			loadBranches();
			loadRemotes();
			// Keep the Stash/Tags badge counts live when git changes out-of-band
			// (e.g. `git stash` / `git tag` run from the terminal).
			loadStash();
			loadTags();
			loadContributors();
			// Refresh log if it was already loaded (History tab was visited)
			if (commits.length > 0) {
				loadLog(true);
			}
		});

		return () => unsub();
	});

	function startColumnResize(e: MouseEvent) {
		isResizing = true;
		const startX = e.clientX;
		const startWidth = leftPanelWidth;

		function onMouseMove(e: MouseEvent) {
			const delta = e.clientX - startX;
			leftPanelWidth = Math.max(120, Math.min(startWidth + delta, containerWidth - 120));
		}

		function onMouseUp() {
			isResizing = false;
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		}

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
	}

	// Monitor container width
	onMount(() => {
		let resizeObserver: ResizeObserver | null = null;
		if (containerRef && typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver((entries) => {
				for (const entry of entries) {
					containerWidth = entry.contentRect.width;
				}
			});
			resizeObserver.observe(containerRef);
		}

		return () => {
			resizeObserver?.disconnect();
		};
	});

	// Combined unstaged + untracked
	const allChanges = $derived([...gitStatus.unstaged, ...gitStatus.untracked]);

	// Total changes count
	const totalChanges = $derived(
		gitStatus.staged.length + allChanges.length + gitStatus.conflicted.length
	);

	// View tabs config for tab bar
	const viewTabs = $derived([
		{ id: 'changes' as const, label: 'Changes', icon: 'lucide:file-pen' as IconName, badge: totalChanges > 0 ? totalChanges : null },
		{ id: 'log' as const, label: 'History', icon: 'lucide:history' as IconName, badge: null },
		{ id: 'branches' as const, label: 'Branches', icon: 'lucide:git-branch' as IconName, badge: branchInfo?.local.length ? branchInfo.local.length : null },
		{ id: 'more' as const, label: 'More', icon: 'lucide:ellipsis' as IconName, badge: null }
	]);

	// Exported panel actions for PanelHeader
	export const panelActions = {
		init: handleInit,
		openBranches: (sub: 'local' | 'remote') => { branchesSubTab = sub; switchToView('branches'); },
		getBranchInfo: () => branchInfo,
		getIsRepo: () => isRepo,
		setViewMode: (mode: 'list' | 'diff') => {
			if (!isTwoColumnMode) viewMode = mode;
		},
		getViewMode: () => viewMode,
		canShowDiff: () => openTabs.length > 0,
		isTwoColumnMode: () => isTwoColumnMode
	};
</script>

<!-- Tab Bar Snippet -->
{#snippet tabBar()}
	{#if openTabs.length > 0}
		<div class="flex items-stretch border-b border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50 flex-shrink-0">
			<div class="flex items-center overflow-x-auto flex-1 min-w-0">
				{#each openTabs as tab, index (tab.id)}
					{@const isActive = tab.id === activeTabId}
					{@const isDragOver = dragOverIndex === index && dragSrcIndex !== null && dragSrcIndex !== index}
					<div
						class="flex items-center gap-1.5 pl-3 pr-2 py-2 text-xs border-r border-slate-200/50 dark:border-slate-700/50 whitespace-nowrap transition-colors flex-shrink-0 cursor-pointer {isActive
							? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
							: 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300'} {isDragOver ? 'ring-2 ring-violet-500/40 ring-inset' : ''}"
						draggable="true"
						ondragstart={(e) => onTabDragStart(e, index)}
						ondragover={(e) => onTabDragOver(e, index)}
						ondragleave={onTabDragLeave}
						ondrop={(e) => onTabDrop(e, index)}
						ondragend={onTabDragEnd}
						onclick={() => selectTab(tab.id)}
					>
						<Icon name={getFileIcon(tab.fileName) as IconName} class="w-3.5 h-3.5 flex-shrink-0" />
						<span class="truncate max-w-28">{tab.fileName}</span>
						{#if tab.isLoading}
							<div class="w-2 h-2 border border-slate-400 border-t-transparent rounded-full animate-spin flex-shrink-0"></div>
						{:else if tab.status}
							<span class="text-xs font-bold {getGitStatusColor(tab.status)} flex-shrink-0">{getGitStatusLabel(tab.status)}</span>
						{/if}
						<button
							class="flex p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded flex-shrink-0 opacity-60 hover:opacity-100"
							onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
							title="Close tab"
						>
							<Icon name="lucide:x" class="w-3 h-3" />
						</button>
					</div>
				{/each}
			</div>
			<button
				type="button"
				class="flex items-center justify-center px-2.5 border-l border-slate-200/50 dark:border-slate-700/50 text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors bg-transparent cursor-pointer flex-shrink-0"
				onclick={closeAllTabs}
				title="Close all tabs"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
		</div>
	{/if}
{/snippet}

<!-- View tabs snippet (always visible, even in single-column diff mode) -->
{#snippet viewTabBar()}
	<div class="relative flex border-b border-slate-200 dark:border-slate-700">
		{#each viewTabs as tab (tab.id)}
			{@const isActive = activeView === tab.id}
			<button
				type="button"
				class="relative flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors {isActive
					? 'text-violet-600 dark:text-violet-400'
					: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={() => switchToView(tab.id)}
			>
				{tab.label}
				{#if tab.badge}
					<span class="min-w-4 h-4 px-1 rounded-full bg-violet-500/15 dark:bg-violet-500/25 text-3xs font-semibold flex items-center justify-center">{tab.badge}</span>
				{/if}
				{#if isActive}
					<span class="absolute bottom-0 inset-x-0 h-px bg-violet-600 dark:bg-violet-400"></span>
				{/if}
			</button>
		{/each}
	</div>
{/snippet}

<!-- Changes list snippet -->
{#snippet changesList()}
	{#if activeView === 'changes'}
		<!-- Commit form -->
		<CommitForm
			stagedCount={gitStatus.staged.length}
			{isCommitting}
			onCommit={handleCommit}
			hasRemotes={remotes.length > 0}
			{selectedRemote}
			currentBranch={branchInfo?.current}
			branchAhead={branchInfo?.ahead ?? 0}
			branchBehind={branchInfo?.behind ?? 0}
			{isPushing}
			{isPulling}
			{isMoreBusy}
			{repoBusy}
			{repoBusyReason}
			onCreateBranch={createBranch}
			onPush={handlePush}
			onPull={handlePull}
			onMoreAction={handleMoreAction}
		/>

		<!-- Changes sections -->
		<div class="flex-1 overflow-y-auto px-1">
			{#if gitStatus.conflicted.length > 0}
				<ChangesSection
					title="Conflicts"
					icon="lucide:triangle-alert"
					files={gitStatus.conflicted}
					section="conflicted"
					activeFilePath={activeTab?.filePath ?? null}
					activeSection={activeTab?.section ?? null}
					onViewDiff={viewDiff}
					onResolve={openConflictResolver}
				/>
			{/if}

			<ChangesSection
				title="Staged Changes"
				icon="lucide:circle-check"
				files={gitStatus.staged}
				section="staged"
				activeFilePath={activeTab?.filePath ?? null}
				activeSection={activeTab?.section ?? null}
				onUnstage={unstageFile}
				onUnstageAll={unstageAll}
				onStash={openStashPrompt}
				onViewDiff={viewDiff}
			/>

			<ChangesSection
				title="Changes"
				icon="lucide:file-pen"
				files={allChanges}
				section="unstaged"
				activeFilePath={activeTab?.filePath ?? null}
				activeSection={activeTab?.section ?? null}
				onStage={stageFile}
				onStageAll={stageAll}
				onDiscard={discardFile}
				onDiscardAll={discardAll}
				onViewDiff={viewDiff}
			/>

			{#if totalChanges === 0 && !isLoading}
				<div class="flex flex-col items-center justify-center gap-2 py-8 text-slate-500 text-xs">
					<Icon name="lucide:circle-check" class="w-6 h-6 opacity-30" />
					<span>Working tree clean</span>
				</div>
			{/if}
		</div>
	{:else if activeView === 'log'}
		{#if selectedCommit}
			<CommitFileList
				commitHash={selectedCommit.hash}
				commitHashShort={selectedCommit.hashShort}
				commitMessage={selectedCommit.message}
				commitAuthor={selectedCommit.author}
				files={selectedCommit.files}
				isLoading={selectedCommit.isLoading}
				activeFilePath={activeTab?.filePath ?? null}
				onBack={backToCommitList}
				onViewFile={viewCommitFileDiff}
			/>
		{:else}
			<GitLog
				{commits}
				isLoading={isLogLoading}
				hasMore={logHasMore}
				activeHash={activeTab?.commitHash ?? null}
				onLoadMore={() => loadLog()}
				onViewCommit={viewCommitDiff}
				onCheckoutCommit={checkoutCommit}
				getRemoteCommitUrl={buildRemoteCommitUrl}
			/>
		{/if}
	{:else if activeView === 'branches'}
		<!-- Branches View -->
		<div class="flex-1 flex flex-col pt-2 min-h-0">
			<div class="flex gap-1 px-2 pb-2 flex-shrink-0">
				<button type="button" class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none {branchesSubTab === 'local' ? 'bg-violet-500/10 text-violet-600' : 'bg-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}" onclick={() => { branchesSubTab = 'local'; showCreateBranchForm = false; newBranchName = ''; }}>Local ({filteredLocalBranches.length})</button>
				<button type="button" class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none {branchesSubTab === 'remote' ? 'bg-violet-500/10 text-violet-600' : 'bg-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}" onclick={() => branchesSubTab = 'remote'}>Remote ({remotes.length})</button>
			</div>
			<div class="px-2 pb-2 flex-shrink-0">
				<div class="flex items-center gap-2 py-1.5 px-2.5 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg">
					<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
					<input type="text" bind:value={branchesSearchQuery} placeholder="Search branches..." class="flex-1 bg-transparent border-none outline-none text-slate-900 dark:text-slate-100 text-xs placeholder:text-slate-500 dark:placeholder:text-slate-400" />
					{#if branchesSearchQuery}
						<button type="button" class="flex items-center justify-center w-5 h-5 bg-transparent border-none rounded text-slate-400 cursor-pointer hover:text-slate-600 dark:hover:text-slate-300" onclick={() => (branchesSearchQuery = '')}><Icon name="lucide:x" class="w-3 h-3" /></button>
					{/if}
				</div>
			</div>
			{#if branchesSubTab === 'local'}
				<div class="px-2 pb-2 flex-shrink-0">
					{#if showCreateBranchForm}
						<div class="p-2.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg space-y-2">
							<input type="text" bind:value={newBranchName} placeholder="New branch name..." class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20" onkeydown={(e) => e.key === 'Enter' && handleCreateBranchFromForm()} autofocus />
							<div class="flex gap-1.5">
								<button type="button" class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer border-none {newBranchName.trim() ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'}" onclick={handleCreateBranchFromForm} disabled={!newBranchName.trim()}>Create Branch</button>
								<button type="button" class="px-3 py-1.5 text-xs font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer" onclick={() => { showCreateBranchForm = false; newBranchName = ''; }}>Cancel</button>
							</div>
						</div>
					{:else}
						<button type="button" class="flex items-center justify-center gap-2 w-full py-2 px-3 border border-dashed border-slate-300 dark:border-slate-600 rounded-lg text-xs text-slate-500 hover:text-violet-600 hover:border-violet-400 transition-colors cursor-pointer bg-transparent" onclick={() => showCreateBranchForm = true}><Icon name="lucide:plus" class="w-3.5 h-3.5" /><span>Create New Branch</span></button>
					{/if}
				</div>
				<div class="flex-1 overflow-y-auto px-2">
					{#if !branchInfo}
						<div class="flex items-center justify-center py-8"><div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div></div>
					{:else if filteredLocalBranches.length === 0}
						<div class="flex flex-col items-center justify-center gap-2 py-8 text-slate-500 text-xs"><Icon name="lucide:git-branch" class="w-6 h-6 opacity-30" /><span>{branchesSearchQuery ? 'No branches match your search' : 'No branches'}</span></div>
					{:else}
						<div class="space-y-0.5">
							{#each filteredLocalBranches as branch (branch.name)}
								{@const upstreamName = getBranchRemoteName(branch)}
								{@const isExpanded = expandedBranches.has(branch.name)}
								{@const commitState = branchCommitState[branch.name]}
								{@const branchRelativeDate = formatRelativeTime(branch.lastCommitDate)}
								<div>
									<div
										class="group relative flex items-center gap-1.5 pl-1.5 pr-2.5 py-1.5 rounded-md transition-colors border cursor-pointer {branch.isCurrent ? 'bg-violet-500/10 border-violet-500/20 text-violet-700 dark:text-violet-300' : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}"
										role="button"
										tabindex="0"
										onclick={() => toggleBranchExpanded(branch.name)}
										onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBranchExpanded(branch.name); } }}
									>
										<Icon name={isExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5 shrink-0 {branch.isCurrent ? 'text-violet-500' : 'text-slate-400'}" />
										<div class="flex-1 min-w-0 flex flex-col justify-center overflow-hidden pr-2 {!branch.isCurrent ? (pushedBranchNames.has(branch.name) ? 'group-hover:pr-24' : 'group-hover:pr-32') : ''} transition-[padding] duration-150">
											<div class="flex min-w-0 items-center gap-2">
												<span class="flex-1 min-w-0 text-sm text-slate-900 dark:text-slate-100 leading-tight truncate" title={branch.name}>{branch.name}</span>
												{#if upstreamName}<span class="text-3xs text-slate-400 shrink-0">{upstreamName}</span>{/if}
											</div>
											<div class="flex min-w-0 items-center gap-1.5 mt-0.5 text-xs text-slate-500 leading-tight">
												{#if branch.ahead > 0}<span class="shrink-0">{branch.ahead} ahead</span>{/if}
												{#if branch.behind > 0}<span class="shrink-0">{branch.behind} behind</span>{/if}
												{#if branch.lastCommit}<span class="min-w-0 truncate">{branch.lastCommit}</span>{/if}
												{#if branchRelativeDate}<span class="shrink-0 whitespace-nowrap">·&nbsp;{branchRelativeDate}</span>{/if}
											</div>
										</div>
										{#if !branch.isCurrent}
										<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 pl-1 pr-2 bg-white/20 opacity-0 backdrop-blur-md supports-[backdrop-filter]:bg-white/10 transition-opacity group-hover:opacity-100 dark:bg-slate-900/20 dark:supports-[backdrop-filter]:bg-slate-900/10">
											<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-violet-500/10 hover:text-violet-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); switchBranch(branch.name); }} title="Switch to this branch"><Icon name="lucide:arrow-right" class="w-3.5 h-3.5" /></button>
											{#if !pushedBranchNames.has(branch.name)}
												{#if pushingBranch === branch.name}
													<div class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-emerald-500"><Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" /></div>
												{:else}
													<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); handlePushBranch(branch.name); }} title="Push branch to remote"><Icon name="lucide:upload" class="w-3.5 h-3.5" /></button>
												{/if}
											{/if}
											<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-blue-500/10 hover:text-blue-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); mergeBranch(branch.name); }} title="Merge into current branch"><Icon name="lucide:git-merge" class="w-3.5 h-3.5" /></button>
											<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); deleteBranch(branch.name); }} title="Delete branch"><Icon name="lucide:trash-2" class="w-3.5 h-3.5" /></button>
										</div>
										{/if}
										<!-- Push button: only for the active branch when it has not
										     yet been pushed to the remote -->
										{#if branch.isCurrent && !pushedBranchNames.has(branch.name)}
											<button type="button" class="ml-1 flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-500 transition-colors bg-transparent border-none cursor-pointer shrink-0" onclick={(e) => { e.stopPropagation(); handlePushBranch(branch.name); }} title="Push branch to remote"><Icon name="lucide:upload" class="w-3.5 h-3.5" /></button>
										{/if}
									</div>
									{#if isExpanded}
										<div class="ml-5 mt-0.5 mb-1 border-l border-slate-200 dark:border-slate-700 pl-2 space-y-0.5">
											{#if commitState?.isLoading && commitState.commits.length === 0}
												<div class="flex items-center gap-2 py-2 text-xs text-slate-400"><div class="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin"></div><span>Loading commits...</span></div>
											{:else if !commitState || commitState.commits.length === 0}
												<div class="py-2 text-xs text-slate-400">No commits</div>
											{:else}
												{#each commitState.commits as commit (commit.hash)}
													{@const commitExpanded = expandedBranchCommits.has(commit.hash)}
													{@const filesState = branchCommitFileState[commit.hash]}
													{@const commitRelativeDate = formatRelativeTime(commit.date)}
													<div>
														<div
															class="group/commit relative flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
															role="button"
															tabindex="0"
															onclick={() => toggleBranchCommitExpanded(commit.hash)}
															onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBranchCommitExpanded(commit.hash); } }}
														>
															<Icon name={commitExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3 h-3 shrink-0 text-slate-400" />
															<div class="flex-1 min-w-0 flex flex-col justify-center overflow-hidden pr-2 {branch.name !== branchInfo?.current ? 'group-hover/commit:pr-9' : ''} transition-[padding] duration-150">
																<div class="flex min-w-0 items-center gap-2">
																	<span class="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-300 leading-tight truncate" title={commit.message}>{commit.message}</span>
																	{#if commitRelativeDate}<span class="text-3xs text-slate-400 shrink-0">{commitRelativeDate}</span>{/if}
																</div>
																<div class="flex min-w-0 items-center gap-1.5 mt-0.5">
																	<button type="button" class="font-mono text-xs text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300 bg-transparent border-none cursor-pointer p-0 shrink-0 transition-colors" onclick={(e) => copyCommitHash(commit.hash, e)} title="Copy commit hash">{commit.hashShort}</button>
																	{#if commit.author}<span class="flex-1 min-w-0 text-xs text-slate-500 truncate">{commit.author}</span>{/if}
																</div>
															</div>
															{#if branch.name !== branchInfo?.current}
																<button type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-emerald-500 hover:bg-emerald-500/10 transition-colors bg-transparent border-none cursor-pointer shrink-0 opacity-0 group-hover/commit:opacity-100" onclick={(e) => { e.stopPropagation(); handleCherryPick(commit.hash); }} title="Cherry-pick this commit onto {branchInfo?.current}"><Icon name="lucide:git-fork" class="w-4 h-4" /></button>
															{/if}
														</div>
														{#if commitExpanded}
															<div class="ml-5 mb-1 border-l border-slate-200 dark:border-slate-700 pl-2 space-y-0.5">
																{#if filesState?.isLoading && filesState.files.length === 0}
																	<div class="flex items-center gap-2 py-1.5 text-xs text-slate-400"><div class="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin"></div><span>Loading files...</span></div>
																{:else if !filesState || filesState.files.length === 0}
																	<div class="py-1.5 text-xs text-slate-400">No files</div>
																{:else}
																	{#each filesState.files as file (`${commit.hash}:${file.oldPath}:${file.newPath}`)}
																		{@const filePath = file.newPath || file.oldPath}
																		{@const fileParts = splitPath(filePath)}
																		<button type="button" class="group/file flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors bg-transparent border-none cursor-pointer" onclick={() => viewCommitFileDiff(file, 0, commit.hash)} title={filePath}><Icon name={getFileIcon(fileParts.fileName) as IconName} class="w-4 h-4 shrink-0" /><div class="flex items-baseline gap-1.5 min-w-0 flex-1"><span class="text-sm text-slate-600 dark:text-slate-300 truncate">{fileParts.fileName}</span>{#if fileParts.dirPath}<span class="text-2xs text-slate-400 dark:text-slate-500 truncate min-w-0" dir="rtl">{fileParts.dirPath}</span>{/if}</div><span class="w-4 text-center text-sm font-bold {getGitStatusColor(file.status)} shrink-0">{getGitStatusLabel(file.status)}</span></button>
																	{/each}
																{/if}
															</div>
														{/if}
													</div>
												{/each}
												{#if commitState.hasMore}<button type="button" class="flex items-center justify-center gap-2 w-full px-2 py-1.5 text-xs rounded-md text-slate-500 hover:text-violet-500 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors bg-transparent border-none cursor-pointer disabled:opacity-50" onclick={() => loadBranchCommits(branch.name)} disabled={commitState.isLoading}>{#if commitState.isLoading}<div class="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin"></div>{/if}<span>Load more</span></button>{/if}
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{:else}
				<div class="flex-1 overflow-y-auto px-2">
					<div class="pb-2">
						{#if showAddRemoteForm}
							<div class="p-2.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg space-y-2">
								<input type="text" bind:value={newRemoteName} placeholder="Remote name (e.g. origin)..." class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20" disabled={addingRemote} />
								<input type="text" bind:value={newRemoteUrl} placeholder="Repository URL..." class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20" onkeydown={(e) => e.key === 'Enter' && handleAddRemote()} disabled={addingRemote} />
								<div class="flex gap-1.5">
									<button type="button" class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer border-none {newRemoteName.trim() && newRemoteUrl.trim() && !addingRemote ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'}" onclick={handleAddRemote} disabled={addingRemote || !newRemoteName.trim() || !newRemoteUrl.trim()}>Add Remote</button>
									<button type="button" class="px-3 py-1.5 text-xs font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer" onclick={() => { showAddRemoteForm = false; newRemoteName = ''; newRemoteUrl = ''; }}>Cancel</button>
								</div>
							</div>
						{:else}
							<button type="button" class="flex items-center justify-center gap-2 w-full py-2 px-3 border border-dashed border-slate-300 dark:border-slate-600 rounded-lg text-xs text-slate-500 hover:text-violet-600 hover:border-violet-400 transition-colors cursor-pointer bg-transparent" onclick={() => showAddRemoteForm = true}><Icon name="lucide:plus" class="w-3.5 h-3.5" /><span>Add Remote</span></button>
						{/if}
					</div>
					{#if !branchInfo}
						<div class="flex items-center justify-center py-8"><div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div></div>
					{:else if remotes.length === 0}
						<div class="flex flex-col items-center gap-2 py-8 text-slate-500 dark:text-slate-400 text-xs"><Icon name="lucide:server-off" class="w-6 h-6 opacity-30" /><span>No remote connections</span></div>
					{:else}
						<div class="space-y-0.5">
							{#each remotes as remote (remote.name)}
								{@const remoteBranches = filteredRemoteBranches.filter(b => b.name.startsWith(remote.name + '/'))}
								{@const isActiveRemote = remote.name === selectedRemote}
								<div>
									{#if editingRemote === remote.name}
										<div class="p-2.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg space-y-2">
											<input type="text" bind:value={editRemoteName} placeholder="Remote name..." class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20" disabled={savingRemote} />
											<input type="text" bind:value={editRemoteUrl} placeholder="Repository URL..." class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20" onkeydown={(e) => e.key === 'Enter' && handleSaveRemote()} disabled={savingRemote} />
											<div class="flex gap-1.5">
												<button type="button" class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer border-none {editRemoteName.trim() && editRemoteUrl.trim() && !savingRemote ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'}" onclick={handleSaveRemote} disabled={savingRemote || !editRemoteName.trim() || !editRemoteUrl.trim()}>Save</button>
												<button type="button" class="px-3 py-1.5 text-xs font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer" onclick={() => { editingRemote = null; editRemoteName = ''; editRemoteUrl = ''; }}>Cancel</button>
											</div>
										</div>
									{:else}
										<div class="group relative flex items-center gap-1.5 pl-1.5 pr-2.5 py-1.5 rounded-md border transition-colors {isActiveRemote ? 'bg-violet-500/10 border-violet-500/20' : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/60'}">
											<Icon name="lucide:server" class="w-4 h-4 shrink-0 text-slate-400" />
											<div class="flex-1 min-w-0 flex flex-col justify-center overflow-hidden pr-2 {isActiveRemote ? 'group-hover:pr-24' : 'group-hover:pr-32'} transition-[padding] duration-150">
												<div class="flex min-w-0 items-center gap-2">
													<span class="min-w-0 text-sm font-medium text-slate-900 dark:text-slate-100 leading-tight truncate">{remote.name}</span>
													{#if isActiveRemote}<span class="shrink-0 text-3xs font-medium px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-600 dark:text-violet-400">Active</span>{/if}
												</div>
												{#if remote.fetchUrl || remote.pushUrl}<span class="text-xs text-slate-500 leading-tight truncate" title={remote.fetchUrl || remote.pushUrl}>{remote.fetchUrl || remote.pushUrl}</span>{/if}
											</div>
											{#if fetchingRemote === remote.name}
												<div class="flex items-center justify-center w-7 h-7 text-slate-500 shrink-0"><Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" /></div>
											{:else}
												<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 pl-1 pr-2 bg-white/20 opacity-0 backdrop-blur-md supports-[backdrop-filter]:bg-white/10 transition-opacity group-hover:opacity-100 dark:bg-slate-900/20 dark:supports-[backdrop-filter]:bg-slate-900/10">
													{#if !isActiveRemote}
														<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-violet-500/10 hover:text-violet-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); setActiveRemote(remote.name); }} title="Set as active remote"><Icon name="lucide:star" class="w-3.5 h-3.5" /></button>
													{/if}
													<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-violet-500/10 hover:text-violet-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); editingRemote = remote.name; editRemoteName = remote.name; editRemoteUrl = remote.fetchUrl || remote.pushUrl || ''; }} title="Edit remote"><Icon name="lucide:pencil" class="w-3.5 h-3.5" /></button>
													<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-blue-500/10 hover:text-blue-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); handleFetchRemote(remote.name); }} title="Fetch"><Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" /></button>
													<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); handleRemoveRemote(remote.name); }} title="Disconnect"><Icon name="lucide:unlink" class="w-3.5 h-3.5" /></button>
												</div>
											{/if}
										</div>
									{/if}
									{#if remoteBranches.length > 0}
										<div class="ml-5 mt-0.5 mb-1 border-l border-slate-200 dark:border-slate-700 pl-2 space-y-0.5">
											{#each remoteBranches as branch (branch.name)}
												{@const branchRelativeDate = formatRelativeTime(branch.lastCommitDate)}
												{@const shortName = branch.name.substring(remote.name.length + 1)}
												{@const isDeleting = deletingRemoteBranch === `${remote.name}/${shortName}`}
												<div class="group/rb relative flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors">
													<div class="flex-1 min-w-0 flex flex-col justify-center overflow-hidden pr-2 group-hover/rb:pr-20 transition-[padding] duration-150">
														<span class="text-sm text-slate-700 dark:text-slate-300 leading-tight truncate" title={branch.name}>{shortName}</span>
														{#if branchRelativeDate}<span class="text-xs text-slate-500 leading-tight">{branchRelativeDate}</span>{/if}
													</div>
													{#if isDeleting}
														<div class="flex items-center justify-center w-7 h-7 text-slate-400 shrink-0"><Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" /></div>
													{:else}
														<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 pl-1 pr-2 bg-white/20 opacity-0 backdrop-blur-md supports-[backdrop-filter]:bg-white/10 transition-opacity group-hover/rb:opacity-100 dark:bg-slate-900/20 dark:supports-[backdrop-filter]:bg-slate-900/10">
															<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-violet-500/10 hover:text-violet-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); checkoutRemoteBranch(branch.name); }} title="Checkout locally"><Icon name="lucide:arrow-right" class="w-3.5 h-3.5" /></button>
															<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-blue-500/10 hover:text-blue-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); copyToClipboard(branch.name); }} title="Copy branch name"><Icon name="lucide:copy" class="w-3.5 h-3.5" /></button>
															<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); handleDeleteRemoteBranch(remote.name, shortName); }} title="Delete branch"><Icon name="lucide:trash-2" class="w-3.5 h-3.5" /></button>
														</div>
													{/if}
												</div>
											{/each}
										</div>
									{:else if !branchesSearchQuery}
										<p class="ml-5 pl-2 text-xs text-slate-400 dark:text-slate-500 py-1">No branches</p>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{:else if activeView === 'more'}
		<!-- More View: Tags / Stash / Contributors -->
		<div class="flex-1 flex flex-col pt-2 min-h-0">
			<div class="flex gap-1 px-2 pb-2 flex-shrink-0">
				<button type="button" class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none {moreSubTab === 'tags' ? 'bg-violet-500/10 text-violet-600' : 'bg-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}" onclick={() => moreSubTab = 'tags'}>Tags{tags.length > 0 ? ` (${tags.length})` : ''}</button>
				<button type="button" class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none {moreSubTab === 'stash' ? 'bg-violet-500/10 text-violet-600' : 'bg-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}" onclick={() => moreSubTab = 'stash'}>Stash{stashEntries.length > 0 ? ` (${stashEntries.length})` : ''}</button>
				<button type="button" class="px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none {moreSubTab === 'contributors' ? 'bg-violet-500/10 text-violet-600' : 'bg-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}" onclick={() => moreSubTab = 'contributors'}>Contributors{contributors.length > 0 ? ` (${contributors.length})` : ''}</button>
			</div>

			{#if moreSubTab === 'tags'}
			<!-- Tags -->
			<div class="flex-1 overflow-y-auto">
				<!-- Create tag button/form -->
				<div class="px-2 pb-2">
				{#if showCreateTagForm}
					<div class="p-2.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg space-y-2">
						<input
							type="text"
							bind:value={newTagName}
							placeholder="Tag name (e.g. v1.0.0)..."
							class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20"
							onkeydown={(e) => e.key === 'Enter' && !newTagMessage && handleCreateTag()}
						/>
						<input
							type="text"
							bind:value={newTagMessage}
							placeholder="Tag message (optional, makes annotated tag)..."
							class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20"
							onkeydown={(e) => e.key === 'Enter' && handleCreateTag()}
						/>
						<div class="flex gap-1.5">
							<button
								type="button"
								class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer border-none
									{newTagName.trim()
										? 'bg-violet-600 text-white hover:bg-violet-700'
										: 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'}"
								onclick={handleCreateTag}
								disabled={!newTagName.trim()}
							>
								Create Tag
							</button>
							<button
								type="button"
								class="px-3 py-1.5 text-xs font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
								onclick={() => { showCreateTagForm = false; newTagName = ''; newTagMessage = ''; }}
							>
								Cancel
							</button>
						</div>
					</div>
				{:else}
					<button
						type="button"
						class="flex items-center justify-center gap-2 w-full py-2 px-3 border border-dashed border-slate-300 dark:border-slate-600 rounded-lg text-xs text-slate-500 hover:text-violet-600 hover:border-violet-400 transition-colors cursor-pointer bg-transparent"
						onclick={() => showCreateTagForm = true}
					>
						<Icon name="lucide:plus" class="w-3.5 h-3.5" />
						<span>Create New Tag</span>
					</button>
				{/if}
			</div>

			{#if isTagsLoading}
				<div class="flex items-center justify-center py-8">
					<div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
				</div>
			{:else if tags.length === 0}
				<div class="flex flex-col items-center justify-center gap-2 py-8 text-slate-500 text-xs">
					<Icon name="lucide:tag" class="w-6 h-6 opacity-30" />
					<span>No tags</span>
				</div>
			{:else}
				<div class="space-y-1 px-1">
					{#each tags as tag (tag.name)}
						<div class="group flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors">
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{tag.name}</p>
								<div class="flex items-center gap-1.5">
									<button
										type="button"
										class="text-xs font-mono text-slate-400 dark:text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 bg-transparent border-none cursor-pointer p-0 shrink-0 transition-colors"
										onclick={(e) => copyTagHash(tag.hash, e)}
										title="Copy tag hash"
									>{tag.hash.slice(0, 7)}</button>
									{#if tag.message}
										<span class="text-xs text-slate-400 dark:text-slate-500 truncate">{tag.message}</span>
									{/if}
								</div>
							</div>
							<div class="flex items-center gap-0.5 shrink-0">
								<button
									type="button"
									class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-blue-500/10 hover:text-blue-500 transition-colors bg-transparent border-none cursor-pointer"
									onclick={() => handlePushTag(tag.name)}
									title="Push tag to remote"
								>
									<Icon name="lucide:arrow-up-from-line" class="w-3.5 h-3.5" />
								</button>
								<button
									type="button"
									class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer"
									onclick={() => handleDeleteTag(tag.name)}
									title="Delete tag"
								>
									<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
			</div>
			{:else if moreSubTab === 'stash'}
			<!-- Stash -->
			<div class="flex-1 overflow-y-auto px-2">
				<div class="pb-2">
					{#if showStashSaveForm}
						<div class="p-2.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg space-y-2">
							<input type="text" data-stash-message-input bind:value={stashMessage} placeholder="Stash message (optional)..." class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20" onkeydown={(e) => e.key === 'Enter' && handleStashSave()} />
							<div class="flex gap-1.5"><button type="button" class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 transition-colors cursor-pointer border-none" onclick={handleStashSave}>Stash Changes</button><button type="button" class="px-3 py-1.5 text-xs font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer" onclick={() => { showStashSaveForm = false; stashMessage = ''; }}>Cancel</button></div>
						</div>
					{:else}
						<button type="button" class="flex items-center justify-center gap-2 w-full py-2 px-3 border border-dashed border-slate-300 dark:border-slate-600 rounded-lg text-xs text-slate-500 hover:text-violet-600 hover:border-violet-400 transition-colors cursor-pointer bg-transparent" onclick={() => showStashSaveForm = true}><Icon name="lucide:plus" class="w-3.5 h-3.5" /><span>Stash Current Changes</span></button>
					{/if}
				</div>
				{#if isStashLoading}
					<div class="flex items-center justify-center py-8"><div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div></div>
				{:else if stashEntries.length === 0}
					<div class="flex flex-col items-center justify-center gap-2 py-8 text-slate-500 text-xs"><Icon name="lucide:archive" class="w-6 h-6 opacity-30" /><span>No stashed changes</span></div>
				{:else}
					<div class="space-y-0.5">
						{#each stashEntries as entry (entry.index)}
							{@const relativeDate = formatRelativeTime(entry.date)}
							{@const stashExpanded = expandedStashes.has(entry.index)}
							{@const sFiles = stashFileState[entry.index]}
							<div>
								<div
									class="group relative flex items-center gap-1.5 pl-1.5 pr-2.5 py-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
									role="button"
									tabindex="0"
									onclick={() => toggleStashExpanded(entry.index)}
									onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleStashExpanded(entry.index); } }}
								>
									<Icon name={stashExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5 shrink-0 text-slate-400" />
									<div class="flex-1 min-w-0 pr-2 group-hover:pr-16 flex flex-col justify-center overflow-hidden transition-[padding] duration-150">
										<p class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{entry.message}</p>
										<p class="text-xs text-slate-400 dark:text-slate-500"><span>stash@&#123;{entry.index}&#125;</span>{#if relativeDate}<span class="mx-1">·</span><span>{relativeDate}</span>{/if}</p>
									</div>
									<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 pl-1 pr-2 bg-white/20 opacity-0 backdrop-blur-md supports-[backdrop-filter]:bg-white/10 transition-opacity group-hover:opacity-100 dark:bg-slate-900/20 dark:supports-[backdrop-filter]:bg-slate-900/10">
										<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); handleStashPop(entry.index); }} title="Pop"><Icon name="lucide:archive-restore" class="w-3.5 h-3.5" /></button>
										<button type="button" class="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer" onclick={(e) => { e.stopPropagation(); handleStashDrop(entry.index); }} title="Drop"><Icon name="lucide:trash-2" class="w-3.5 h-3.5" /></button>
									</div>
								</div>
								{#if stashExpanded}
									<div class="ml-5 mt-0.5 mb-1 border-l border-slate-200 dark:border-slate-700 pl-2 space-y-0.5">
										{#if sFiles?.isLoading && sFiles.files.length === 0}
											<div class="flex items-center gap-2 py-1.5 text-xs text-slate-400"><div class="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin"></div><span>Loading files...</span></div>
										{:else if !sFiles || sFiles.files.length === 0}
											<div class="py-1.5 text-xs text-slate-400">No files</div>
										{:else}
											{#each sFiles.files as file (`${entry.index}:${file.oldPath}:${file.newPath}`)}
												{@const filePath = file.newPath || file.oldPath}
												{@const fileParts = splitPath(filePath)}
												<button type="button" class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors bg-transparent border-none cursor-pointer" onclick={() => viewStashFileDiff(file, entry.index)} title={filePath}><Icon name={getFileIcon(fileParts.fileName) as IconName} class="w-4 h-4 shrink-0" /><div class="flex items-baseline gap-1.5 min-w-0 flex-1"><span class="text-sm text-slate-600 dark:text-slate-300 truncate">{fileParts.fileName}</span>{#if fileParts.dirPath}<span class="text-2xs text-slate-400 dark:text-slate-500 truncate min-w-0" dir="rtl">{fileParts.dirPath}</span>{/if}</div><span class="w-4 text-center text-sm font-bold {getGitStatusColor(file.status)} shrink-0">{getGitStatusLabel(file.status)}</span></button>
											{/each}
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
			{:else}
			<!-- Contributors -->
			<div class="flex-1 overflow-y-auto px-2">
				{#if isContributorsLoading}
					<div class="flex items-center justify-center py-8"><div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div></div>
				{:else if contributors.length === 0}
					<div class="flex flex-col items-center justify-center gap-2 py-8 text-slate-500 text-xs"><Icon name="lucide:users" class="w-6 h-6 opacity-30" /><span>No contributors</span></div>
				{:else}
					<div class="space-y-0.5">
						{#each contributors as c, ci (`${c.email}:${ci}`)}
							<div class="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors">
								<span class="w-6 h-6 rounded-full bg-violet-500/10 text-violet-600 flex items-center justify-center text-xs font-bold flex-shrink-0">{c.name.charAt(0).toUpperCase()}</span>
								<div class="flex-1 min-w-0">
									<p class="text-sm text-slate-700 dark:text-slate-300 truncate">{c.name}</p>
									<p class="text-xs text-slate-400 dark:text-slate-500 truncate">{c.email}</p>
								</div>
								<span class="text-xs text-slate-400 flex-shrink-0">{c.count}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
			{/if}
		</div>
	{/if}
{/snippet}

<!-- Diff panel snippet -->
{#snippet diffPanel()}
	{@render tabBar()}
	<div class="flex-1 overflow-hidden">
		{#if activeTab}
			<DiffViewer
				diff={activeTab.diff}
				isLoading={activeTab.isLoading}
				inlinePreview={activeTab.section === 'conflicted'}
				scrollTop={activeTab.scrollTop ?? 0}
				onScroll={handleDiffScroll}
			/>
		{:else}
			<div class="h-full flex flex-col items-center justify-center gap-2 text-slate-500 text-xs">
				<Icon name="lucide:file-diff" class="w-8 h-8 opacity-30" />
				<span>Select a file to view diff</span>
			</div>
		{/if}
	</div>
{/snippet}

<div class="h-full flex flex-col bg-transparent" bind:this={containerRef}>
	{#if !hasActiveProject}
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-600 dark:text-slate-500 text-sm">
			<Icon name="lucide:git-branch" class="w-10 h-10 opacity-30" />
			<span>No project selected</span>
		</div>
	{:else if isLoading && !isRepo}
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-600 dark:text-slate-500 text-sm">
			<div class="w-6 h-6 border-2 border-slate-200 dark:border-slate-800 border-t-violet-600 rounded-full animate-spin"></div>
			<span>Loading...</span>
		</div>
	{:else if !isRepo}
		<div class="flex-1 flex flex-col items-center justify-center gap-4 text-slate-600 dark:text-slate-500 text-sm px-6">
			<Icon name="lucide:git-branch" class="w-10 h-10 opacity-30" />
			<span>Not a git repository</span>
			<p class="text-xs text-slate-400 dark:text-slate-500 text-center max-w-60">
				Initialize a git repository to start tracking your changes.
			</p>
			<button
				type="button"
				class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150
					{isInitializing
						? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
						: 'bg-violet-600 text-white hover:bg-violet-700 cursor-pointer'}"
				onclick={handleInit}
				disabled={isInitializing}
			>
				{#if isInitializing}
					<div class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
					<span>Initializing...</span>
				{:else}
					<Icon name="lucide:folder-git-2" class="w-4 h-4" />
					<span>Initialize Repository</span>
				{/if}
			</button>
		</div>
	{:else}
		<div class="flex-1 overflow-hidden">
			<!-- Unified layout: always render both panels to preserve state (like Files panel) -->
			<div class="h-full flex" class:select-none={isResizing} class:cursor-col-resize={isResizing}>
				<!-- Left panel: Changes list -->
				<div
					class={isTwoColumnMode
						? 'flex-shrink-0 h-full overflow-hidden flex flex-col'
						: (viewMode === 'list' ? 'w-full h-full overflow-hidden flex flex-col' : 'hidden')}
					style={isTwoColumnMode ? `width: ${leftPanelWidth}px` : undefined}
				>
					{@render viewTabBar()}
					<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
						{@render changesList()}
					</div>
				</div>


				{#if isTwoColumnMode}
				<!-- Column resize handle -->
				<div
					class="relative flex-shrink-0 h-full w-px cursor-col-resize group"
					role="separator"
					aria-orientation="vertical"
					onmousedown={startColumnResize}
				>
					<!-- Invisible extended hit area (6px each side) -->
					<div class="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize z-10"></div>
					<!-- Visual line: 1px default, expands to 4px on hover -->
					<div class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px group-hover:w-1 bg-slate-200 dark:bg-slate-700 group-hover:bg-blue-400 dark:group-hover:bg-blue-500 transition-all duration-150"></div>
				</div>
			{/if}

			<!-- Right panel: Diff viewer -->
				<div
					class={isTwoColumnMode
						? 'flex-1 h-full overflow-hidden flex flex-col'
						: (viewMode === 'diff' ? 'w-full h-full flex flex-col' : 'hidden')}
				>
					{@render diffPanel()}
				</div>
			</div>
		</div>
	{/if}


	<!-- Merge Branch Modal -->
	<Modal
		isOpen={showMergeBranchModal}
		onClose={closeMergeBranchModal}
		size="md"
	>
		{#snippet header()}
			<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
				<div class="flex items-center gap-2.5">
					<Icon name="lucide:git-merge" class="w-5 h-5 text-violet-600" />
					<div>
						<h2 class="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">Merge Branch</h2>
						<p class="text-xs text-slate-500 dark:text-slate-400">
							Merge into <span class="font-mono text-slate-700 dark:text-slate-300">{branchInfo?.current ?? 'current branch'}</span>
						</p>
					</div>
				</div>
				<button
					type="button"
					class="p-1.5 md:p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors"
					onclick={closeMergeBranchModal}
					aria-label="Close merge branch modal"
				>
					<Icon name="lucide:x" class="w-4 h-4 md:w-5 md:h-5" />
				</button>
			</div>
		{/snippet}

		{#snippet children()}
			<div class="space-y-4">
					<div>
						<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" for="merge-branch-select">
							Source Branch
						</label>
						<p class="mb-2 text-xs text-slate-500 dark:text-slate-400">
							Local branches only. The current branch is selected automatically as the merge target.
						</p>
						<select
						id="merge-branch-select"
						bind:value={mergeBranchName}
						class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40"
						disabled={mergeableBranches.length === 0 || isMoreBusy}
					>
						{#each mergeableBranches as branch (branch.name)}
							<option value={branch.name}>{branch.name}</option>
						{/each}
					</select>
					{#if selectedMergeBranch}
						<p class="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
							{selectedMergeBranch.ahead} ahead, {selectedMergeBranch.behind} behind relative to upstream.
						</p>
					{/if}
				</div>

				<div>
					<div class="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Merge Mode</div>
					<div class="grid grid-cols-1 gap-2">
						<button
							type="button"
							class="flex items-start gap-3 p-3 rounded-lg border text-left transition-colors
								{mergeMode === 'default'
									? 'border-violet-500 bg-violet-500/10'
									: 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-violet-400'}"
							onclick={() => mergeMode = 'default'}
							disabled={isMoreBusy}
						>
							<span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border {mergeMode === 'default' ? 'border-violet-600 bg-violet-600' : 'border-slate-300 dark:border-slate-600'}">
								{#if mergeMode === 'default'}
									<span class="h-1.5 w-1.5 rounded-full bg-white"></span>
								{/if}
							</span>
							<span class="min-w-0">
								<span class="block text-sm font-semibold text-slate-900 dark:text-slate-100">Default</span>
								<span class="block text-xs text-slate-500 dark:text-slate-400">
									Runs <code class="font-mono">git merge &lt;branch&gt;</code>. Git may fast-forward when possible, otherwise it creates a merge commit.
								</span>
							</span>
						</button>

						<button
							type="button"
							class="flex items-start gap-3 p-3 rounded-lg border text-left transition-colors
								{mergeMode === 'no-ff'
									? 'border-violet-500 bg-violet-500/10'
									: 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-violet-400'}"
							onclick={() => mergeMode = 'no-ff'}
							disabled={isMoreBusy}
						>
							<span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border {mergeMode === 'no-ff' ? 'border-violet-600 bg-violet-600' : 'border-slate-300 dark:border-slate-600'}">
								{#if mergeMode === 'no-ff'}
									<span class="h-1.5 w-1.5 rounded-full bg-white"></span>
								{/if}
							</span>
							<span class="min-w-0">
								<span class="block text-sm font-semibold text-slate-900 dark:text-slate-100">--no-ff</span>
								<span class="block text-xs text-slate-500 dark:text-slate-400">
									Runs <code class="font-mono">git merge --no-ff &lt;branch&gt;</code>. Always creates a merge commit to preserve branch history.
								</span>
							</span>
						</button>
					</div>
				</div>
			</div>
		{/snippet}

		{#snippet footer()}
			<button
				type="button"
				class="px-3 py-2 text-sm font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
				onclick={closeMergeBranchModal}
				disabled={isMoreBusy}
			>
				Cancel
			</button>
			<button
				type="button"
				class="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-lg transition-colors
					{mergeBranchName && !isMoreBusy
						? 'bg-violet-600 text-white hover:bg-violet-700 cursor-pointer'
						: 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'}"
				onclick={() => void runMergeBranch(mergeBranchName, mergeMode === 'no-ff')}
				disabled={!mergeBranchName || isMoreBusy}
			>
				{#if isMoreBusy}
					<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
				{:else}
					<Icon name="lucide:git-merge" class="w-3.5 h-3.5" />
				{/if}
				Merge Branch
			</button>
		{/snippet}
	</Modal>


	<!-- Conflict Resolver Modal -->
	<ConflictResolver
		isOpen={showConflictResolver}
		{conflictFiles}
		isLoading={isConflictLoading}
		initialPath={conflictInitialPath}
		onResolve={resolveConflict}
		onResolveWithAI={resolveWithAI}
		onResolveAllWithAI={resolveAllWithAI}
		onAbortMerge={abortMerge}
		onClose={() => {
			showConflictResolver = false;
			conflictInitialPath = null;
		}}
	/>

	<!-- Confirm Dialog -->
	<Dialog
		bind:isOpen={showConfirmDialog}
		onClose={closeConfirmDialog}
		type={confirmConfig.type}
		title={confirmConfig.title}
		message={confirmConfig.message}
		confirmText={confirmConfig.confirmText}
		cancelText={confirmConfig.cancelText}
		onConfirm={confirmConfig.onConfirm}
	/>
</div>
