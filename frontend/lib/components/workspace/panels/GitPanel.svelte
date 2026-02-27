<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import Dialog from '$frontend/lib/components/common/Dialog.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import { showError, showInfo } from '$frontend/lib/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/lib/utils/ws';
	import { getFileIcon } from '$frontend/lib/utils/file-icon-mappings';
	import { getGitStatusLabel, getGitStatusColor } from '$frontend/lib/utils/git-status';
	import type { IconName } from '$shared/types/ui/icons';
	import type {
		GitStatus,
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
	import CommitForm from '$frontend/lib/components/git/CommitForm.svelte';
	import ChangesSection from '$frontend/lib/components/git/ChangesSection.svelte';
	import DiffViewer from '$frontend/lib/components/git/DiffViewer.svelte';
	import BranchManager from '$frontend/lib/components/git/BranchManager.svelte';
	import GitLog from '$frontend/lib/components/git/GitLog.svelte';
	import ConflictResolver from '$frontend/lib/components/git/ConflictResolver.svelte';

	// Derived state
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectId = $derived(projectState.currentProject?.id || '');

	// Git state
	let isRepo = $state(false);
	let isLoading = $state(false);
	let gitStatus = $state<GitStatus>({ staged: [], unstaged: [], untracked: [], conflicted: [] });
	let branchInfo = $state<GitBranchInfo | null>(null);
	let isCommitting = $state(false);

	// Remote state
	let remotes = $state<GitRemote[]>([]);
	let selectedRemote = $state('origin');

	// View state
	let activeView = $state<'changes' | 'log' | 'stash' | 'tags'>('changes');
	let viewMode = $state<'list' | 'diff'>('list');
	let showBranchManager = $state(false);
	let showConflictResolver = $state(false);

	// Git init state
	let isInitializing = $state(false);

	// Stash state
	let stashEntries = $state<GitStashEntry[]>([]);
	let isStashLoading = $state(false);
	let showStashSaveForm = $state(false);
	let stashMessage = $state('');

	// Tags state
	let tags = $state<GitTag[]>([]);
	let isTagsLoading = $state(false);
	let showCreateTagForm = $state(false);
	let newTagName = $state('');
	let newTagMessage = $state('');

	// More menu state (for Stash/Tags)
	let showMoreMenu = $state(false);

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
	}

	// Per-view tab isolation — each view (Changes, History, Stash, Tags) has its own tabs
	const _tabStore: Record<string, DiffTab[]> = { changes: [], log: [], stash: [], tags: [] };
	const _activeTabStore: Record<string, string | null> = { changes: null, log: null, stash: null, tags: null };
	const _viewModeStore: Record<string, 'list' | 'diff'> = { changes: 'list', log: 'list', stash: 'list', tags: 'list' };

	let openTabs = $state<DiffTab[]>([]);
	let activeTabId = $state<string | null>(null);

	const activeTab = $derived(openTabs.find(t => t.id === activeTabId) || null);

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

	// Conflict state
	let conflictFiles = $state<GitConflictFile[]>([]);
	let isConflictLoading = $state(false);

	// Container width for responsive layout (same threshold as Files: 800)
	let containerRef = $state<HTMLDivElement | null>(null);
	let containerWidth = $state(0);
	const TWO_COLUMN_THRESHOLD = 800;
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
			await Promise.all([loadStatus(), loadBranches(), loadRemotes()]);
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

	async function loadBranches() {
		if (!projectId) return;
		try {
			branchInfo = await ws.http('git:branches', { projectId });
		} catch (err) {
			debug.error('git', 'Failed to load branches:', err);
		}
	}

	async function loadRemotes() {
		if (!projectId) return;
		try {
			const list = await ws.http('git:remotes', { projectId });
			remotes = list;
			// Auto-select first remote if current selection doesn't exist
			if (list.length > 0 && !list.find(r => r.name === selectedRemote)) {
				selectedRemote = list[0].name;
			}
		} catch (err) {
			debug.error('git', 'Failed to load remotes:', err);
		}
	}

	async function loadLog(reset = false) {
		if (!projectId) return;
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
		} catch (err) {
			debug.error('git', 'Failed to stage file:', err);
		}
	}

	async function stageAll() {
		if (!projectId) return;
		try {
			await ws.http('git:stage-all', { projectId });
			await loadStatus();
		} catch (err) {
			debug.error('git', 'Failed to stage all:', err);
		}
	}

	async function unstageFile(path: string) {
		if (!projectId) return;
		try {
			await ws.http('git:unstage', { projectId, filePath: path });
			await loadStatus();
		} catch (err) {
			debug.error('git', 'Failed to unstage file:', err);
		}
	}

	async function unstageAll() {
		if (!projectId) return;
		try {
			await ws.http('git:unstage-all', { projectId });
			await loadStatus();
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
	}

	// ============================
	// Diff
	// ============================

	// Detect binary files by extension (for fallback when git diff returns empty)
	function isBinaryByExtension(filePath: string): boolean {
		const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
		return [
			'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
			'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
			'.zip', '.tar', '.gz', '.7z', '.rar', '.bz2',
			'.exe', '.dll', '.so', '.dylib',
			'.woff', '.woff2', '.ttf', '.eot', '.otf',
			'.mp3', '.mp4', '.wav', '.avi', '.mkv', '.flv', '.mov', '.ogg',
			'.sqlite', '.db',
		].includes(ext);
	}

	async function viewDiff(file: GitFileChange, section: string) {
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
			status
		}];
		activeTabId = tabId;
		if (!isTwoColumnMode) viewMode = 'diff';

		try {
			const action = section === 'staged' ? 'git:diff-staged' : 'git:diff-unstaged';
			const diffs = await ws.http(action, { projectId, filePath: file.path });
			let diffResult: GitFileDiff | null = diffs.length > 0 ? diffs[0] : null;

			// When git diff returns empty (e.g. untracked files), create a synthetic diff
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

			openTabs = openTabs.map(t =>
				t.id === tabId ? { ...t, diff: diffResult, isLoading: false } : t
			);
		} catch (err) {
			debug.error('git', 'Failed to load diff:', err);
			openTabs = openTabs.map(t =>
				t.id === tabId ? { ...t, diff: null, isLoading: false } : t
			);
		}
	}

	async function viewCommitDiff(hash: string) {
		if (!projectId) return;
		const loadingTabId = `commit:${hash}`;

		// History view: show loading placeholder, then replace with per-file tabs
		openTabs = [{
			id: loadingTabId,
			filePath: hash,
			fileName: `Commit ${hash.substring(0, 7)}`,
			section: 'commit',
			diff: null,
			diffs: [],
			isLoading: true,
			commitHash: hash
		}];
		activeTabId = loadingTabId;
		if (!isTwoColumnMode) viewMode = 'diff';

		try {
			const diffs = await ws.http('git:diff-commit', { projectId, commitHash: hash });
			if (diffs.length === 0) {
				openTabs = [{
					id: loadingTabId,
					filePath: hash,
					fileName: `Commit ${hash.substring(0, 7)}`,
					section: 'commit',
					diff: null,
					diffs: [],
					isLoading: false,
					commitHash: hash
				}];
				return;
			}

			// Create one tab per file in the commit
			const fileTabs: DiffTab[] = diffs.map((d: GitFileDiff, i: number) => {
				const path = d.newPath || d.oldPath || `file-${i}`;
				const name = path.split(/[\\/]/).pop() || path;
				return {
					id: `commit:${hash}:${path}`,
					filePath: path,
					fileName: name,
					section: 'commit',
					diff: d,
					diffs: [],
					isLoading: false,
					commitHash: hash,
					status: d.status
				};
			});
			openTabs = fileTabs;
			activeTabId = fileTabs[0].id;
		} catch (err) {
			debug.error('git', 'Failed to load commit diff:', err);
			openTabs = [{
				id: loadingTabId,
				filePath: hash,
				fileName: `Commit ${hash.substring(0, 7)}`,
				section: 'commit',
				diff: null,
				diffs: [],
				isLoading: false,
				commitHash: hash
			}];
		}
	}

	// ============================
	// Branch Operations
	// ============================

	async function switchBranch(name: string) {
		if (!projectId) return;
		try {
			await ws.http('git:switch-branch', { projectId, name });
			showBranchManager = false;
			await loadAll();
		} catch (err) {
			debug.error('git', 'Failed to switch branch:', err);
			showError('Switch Branch Failed', err instanceof Error ? err.message : 'Unknown error');
		}
	}

	async function createBranch(name: string) {
		if (!projectId) return;
		try {
			await ws.http('git:create-branch', { projectId, name });
			showBranchManager = false;
			await loadAll();
		} catch (err) {
			debug.error('git', 'Failed to create branch:', err);
			showError('Create Branch Failed', err instanceof Error ? err.message : 'Unknown error');
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
								await loadBranches();
							} catch (forceErr) {
								showError('Force Delete Failed', forceErr instanceof Error ? forceErr.message : 'Unknown error');
							}
						}
					});
				}
			}
		});
	}

	async function renameBranch(oldName: string, newName: string) {
		if (!projectId) return;
		try {
			await ws.http('git:rename-branch', { projectId, oldName, newName });
			await loadBranches();
		} catch (err) {
			debug.error('git', 'Failed to rename branch:', err);
		}
	}

	async function mergeBranch(name: string) {
		requestConfirm({
			title: 'Merge Branch',
			message: `Merge "${name}" into "${branchInfo?.current}"?`,
			type: 'info',
			confirmText: 'Merge',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					const result = await ws.http('git:merge-branch', { projectId, branchName: name });
					showBranchManager = false;
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
					}
				} catch (err) {
					debug.error('git', 'Failed to merge branch:', err);
				}
			}
		});
	}

	// ============================
	// Remote Operations
	// ============================

	let isFetching = $state(false);
	let isPulling = $state(false);
	let isPushing = $state(false);

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
		isPulling = true;
		try {
			const prevBehind = branchInfo?.behind ?? 0;
			const result = await ws.http('git:pull', { projectId, remote: selectedRemote });
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
		isPushing = true;
		try {
			const prevAhead = branchInfo?.ahead ?? 0;
			const result = await ws.http('git:push', { projectId, remote: selectedRemote });
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

	function resolveWithAI(filePath: string) {
		showConflictResolver = false;
		showInfo('AI Conflict Resolution', `To resolve "${filePath}" with AI, open the Chat panel and describe the conflict. The AI will help you resolve it.`);
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

	async function handleStashPop(index: number) {
		if (!projectId) return;
		try {
			await ws.http('git:stash-pop', { projectId, index });
			await Promise.all([loadStash(), loadStatus()]);
		} catch (err) {
			debug.error('git', 'Stash pop failed:', err);
			showError('Stash Pop Failed', err instanceof Error ? err.message : 'Unknown error');
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

	// ============================
	// Lifecycle
	// ============================

	$effect(() => {
		if (hasActiveProject && projectId) {
			const prevId = untrack(() => lastProjectId);
			if (projectId !== prevId) {
				lastProjectId = projectId;
				activeView = 'changes';
				resetAllViewTabs();
				commits = [];
				logSkip = 0;
				loadAll();
			}
		}
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

	// Load stash when switching to stash view
	$effect(() => {
		if (activeView === 'stash' && isRepo) {
			untrack(() => loadStash());
		}
	});

	// Load tags when switching to tags view
	$effect(() => {
		if (activeView === 'tags' && isRepo) {
			untrack(() => loadTags());
		}
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

	// Start file watcher for this project (idempotent — won't duplicate if FilesPanel already started it)
	$effect(() => {
		if (hasActiveProject && projectId && projectState.currentProject?.path) {
			ws.emit('files:watch', { projectPath: projectState.currentProject.path });
		}
	});

	// Debounce timer for file/git change events
	let changeDebounce: ReturnType<typeof setTimeout> | null = null;

	// Shared refresh logic for both file changes and git state changes
	function scheduleGitRefresh() {
		if (changeDebounce) clearTimeout(changeDebounce);
		changeDebounce = setTimeout(async () => {
			changeDebounce = null;
			// Refresh git status
			await loadStatus();

			// Refresh the active diff tab if currently viewing one
			if (activeTab && !activeTab.isLoading && activeTab.section !== 'commit') {
				const tab = activeTab;
				try {
					const action = tab.section === 'staged' ? 'git:diff-staged' : 'git:diff-unstaged';
					const diffs = await ws.http(action, { projectId, filePath: tab.filePath });
					const diffResult = diffs.length > 0 ? diffs[0] : null;
					openTabs = openTabs.map(t =>
						t.id === tab.id ? { ...t, diff: diffResult } : t
					);
				} catch {
					// Silently ignore — file may have been removed from status
				}
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
			// Also refresh branches in case of branch switch/create/delete
			loadBranches();
			// Refresh log if it was already loaded (History tab was visited)
			if (commits.length > 0) {
				loadLog(true);
			}
		});

		return () => unsub();
	});

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

	// Exported panel actions for PanelHeader
	export const panelActions = {
		push: handlePush,
		pull: handlePull,
		fetch: handleFetch,
		init: handleInit,
		getBranchInfo: () => branchInfo,
		getIsRepo: () => isRepo,
		getIsFetching: () => isFetching,
		getIsPulling: () => isPulling,
		getIsPushing: () => isPushing,
		getRemotes: () => remotes,
		getHasRemotes: () => remotes.length > 0,
		getSelectedRemote: () => selectedRemote,
		setSelectedRemote: (name: string) => { selectedRemote = name; },
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
		<div class="flex items-center border-b border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50 overflow-x-auto flex-shrink-0">
			{#each openTabs as tab (tab.id)}
				{@const isActive = tab.id === activeTabId}
				<div
					class="flex items-center gap-1.5 pl-3 pr-4 py-2 text-xs border-r border-slate-200/50 dark:border-slate-700/50 whitespace-nowrap transition-colors flex-shrink-0 cursor-pointer {isActive
						? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
						: 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300'}"
					onclick={() => selectTab(tab.id)}
				>
					<Icon name={getFileIcon(tab.fileName) as IconName} class="w-3.5 h-3.5 flex-shrink-0" />
					<span class="truncate max-w-28">{tab.fileName}</span>
					{#if tab.isLoading}
						<div class="w-2 h-2 border border-slate-400 border-t-transparent rounded-full animate-spin flex-shrink-0"></div>
					{:else if tab.status}
						<span class="text-xs font-bold {getGitStatusColor(tab.status)} flex-shrink-0">{getGitStatusLabel(tab.status)}</span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
{/snippet}

<!-- Changes list snippet -->
{#snippet changesList()}
	<!-- View tabs with branch switch -->
	<div class="flex items-center gap-1 px-2 py-1.5 border-b border-slate-100 dark:border-slate-800">
		<button
			type="button"
			class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 hover:bg-violet-500/10 hover:text-violet-600 transition-colors cursor-pointer border-none min-w-0"
			onclick={() => showBranchManager = true}
			title="Switch Branch"
		>
			<Icon name="lucide:git-branch" class="w-3.5 h-3.5 shrink-0" />
			<span class="truncate max-w-24">{branchInfo?.current || '...'}</span>
		</button>

		<div class="flex-1"></div>

		<!-- Primary tabs: Changes & History -->
		<button
			type="button"
			class="px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none
				{activeView === 'changes'
					? 'bg-violet-500/10 text-violet-600'
					: 'bg-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
			onclick={() => { switchToView('changes'); showMoreMenu = false; }}
		>
			Changes{totalChanges > 0 ? ` (${totalChanges})` : ''}
		</button>
		<button
			type="button"
			class="px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer border-none
				{activeView === 'log'
					? 'bg-violet-500/10 text-violet-600'
					: 'bg-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
			onclick={() => { switchToView('log'); showMoreMenu = false; }}
		>
			History
		</button>

		<!-- More menu (Stash, Tags) -->
		<div class="relative">
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer border-none
					{activeView === 'stash' || activeView === 'tags'
						? 'bg-violet-500/10 text-violet-600'
						: 'bg-transparent text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}"
				onclick={() => showMoreMenu = !showMoreMenu}
				title="More views"
			>
				<Icon name="lucide:ellipsis" class="w-4 h-4" />
			</button>

			{#if showMoreMenu}
				<div
					class="fixed inset-0 z-40"
					onclick={() => showMoreMenu = false}
				></div>
				<div class="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 min-w-32">
					<button
						type="button"
						class="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-medium text-left transition-colors cursor-pointer border-none
							{activeView === 'stash'
								? 'bg-violet-500/10 text-violet-600'
								: 'bg-transparent text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}"
						onclick={() => { switchToView('stash'); showMoreMenu = false; }}
					>
						<Icon name="lucide:archive" class="w-3.5 h-3.5" />
						Stash
						{#if stashEntries.length > 0}
							<span class="ml-auto text-3xs font-semibold text-slate-400">{stashEntries.length}</span>
						{/if}
					</button>
					<button
						type="button"
						class="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-medium text-left transition-colors cursor-pointer border-none
							{activeView === 'tags'
								? 'bg-violet-500/10 text-violet-600'
								: 'bg-transparent text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}"
						onclick={() => { switchToView('tags'); showMoreMenu = false; }}
					>
						<Icon name="lucide:tag" class="w-3.5 h-3.5" />
						Tags
						{#if tags.length > 0}
							<span class="ml-auto text-3xs font-semibold text-slate-400">{tags.length}</span>
						{/if}
					</button>
				</div>
			{/if}
		</div>
	</div>

	{#if activeView === 'changes'}
		<!-- Commit form -->
		<CommitForm
			stagedCount={gitStatus.staged.length}
			{isCommitting}
			onCommit={handleCommit}
		/>

		<!-- Changes sections -->
		<div class="flex-1 overflow-y-auto px-1">
			{#if gitStatus.conflicted.length > 0}
				<ChangesSection
					title="Conflicts"
					icon="lucide:triangle-alert"
					files={gitStatus.conflicted}
					section="conflicted"
					onViewDiff={viewDiff}
					onResolve={openConflictResolver}
				/>
			{/if}

			<ChangesSection
				title="Staged Changes"
				icon="lucide:circle-check"
				files={gitStatus.staged}
				section="staged"
				onUnstage={unstageFile}
				onUnstageAll={unstageAll}
				onViewDiff={viewDiff}
			/>

			<ChangesSection
				title="Changes"
				icon="lucide:file-pen"
				files={allChanges}
				section="unstaged"
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
		<GitLog
			{commits}
			isLoading={isLogLoading}
			hasMore={logHasMore}
			onLoadMore={() => loadLog()}
			onViewCommit={viewCommitDiff}
		/>
	{:else if activeView === 'stash'}
		<!-- Stash View -->
		<div class="flex-1 overflow-y-auto">
			<!-- Stash save button/form -->
			<div class="px-2 pb-2">
				{#if showStashSaveForm}
					<div class="p-2.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg space-y-2">
						<input
							type="text"
							bind:value={stashMessage}
							placeholder="Stash message (optional)..."
							class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20"
							onkeydown={(e) => e.key === 'Enter' && handleStashSave()}
						/>
						<div class="flex gap-1.5">
							<button
								type="button"
								class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md bg-violet-600 text-white hover:bg-violet-700 transition-colors cursor-pointer border-none"
								onclick={handleStashSave}
							>
								Stash Changes
							</button>
							<button
								type="button"
								class="px-3 py-1.5 text-xs font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
								onclick={() => { showStashSaveForm = false; stashMessage = ''; }}
							>
								Cancel
							</button>
						</div>
					</div>
				{:else}
					<button
						type="button"
						class="flex items-center justify-center gap-2 w-full py-2 px-3 border border-dashed border-slate-300 dark:border-slate-600 rounded-lg text-xs text-slate-500 hover:text-violet-600 hover:border-violet-400 transition-colors cursor-pointer bg-transparent"
						onclick={() => showStashSaveForm = true}
					>
						<Icon name="lucide:archive" class="w-3.5 h-3.5" />
						<span>Stash Current Changes</span>
					</button>
				{/if}
			</div>

			{#if isStashLoading}
				<div class="flex items-center justify-center py-8">
					<div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
				</div>
			{:else if stashEntries.length === 0}
				<div class="flex flex-col items-center justify-center gap-2 py-8 text-slate-500 text-xs">
					<Icon name="lucide:archive" class="w-6 h-6 opacity-30" />
					<span>No stashed changes</span>
				</div>
			{:else}
				<div class="space-y-1 px-1">
					{#each stashEntries as entry (entry.index)}
						<div class="group flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors">
							<Icon name="lucide:archive" class="w-4 h-4 text-slate-400 shrink-0" />
							<div class="flex-1 min-w-0">
								<p class="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">{entry.message}</p>
								<p class="text-3xs text-slate-400 dark:text-slate-500">stash@&#123;{entry.index}&#125;</p>
							</div>
							<div class="flex items-center gap-0.5 shrink-0">
								<button
									type="button"
									class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-500 transition-colors bg-transparent border-none cursor-pointer"
									onclick={() => handleStashPop(entry.index)}
									title="Pop (apply and remove)"
								>
									<Icon name="lucide:archive-restore" class="w-3.5 h-3.5" />
								</button>
								<button
									type="button"
									class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer"
									onclick={() => handleStashDrop(entry.index)}
									title="Drop (delete)"
								>
									<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{:else if activeView === 'tags'}
		<!-- Tags View -->
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
						<Icon name="lucide:tag" class="w-3.5 h-3.5" />
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
							<Icon
								name={tag.isAnnotated ? 'lucide:bookmark' : 'lucide:tag'}
								class="w-4 h-4 shrink-0 {tag.isAnnotated ? 'text-amber-500' : 'text-slate-400'}"
							/>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-1.5">
									<p class="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">{tag.name}</p>
									{#if tag.isAnnotated}
										<span class="text-3xs px-1 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">annotated</span>
									{/if}
								</div>
								{#if tag.message}
									<p class="text-3xs text-slate-500 dark:text-slate-400 truncate">{tag.message}</p>
								{/if}
								<p class="text-3xs text-slate-400 dark:text-slate-500 font-mono">{tag.hash}</p>
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
			<div class="h-full flex">
				<!-- Left panel: Changes list (w-80 like Files panel tree) -->
				<div
					class={isTwoColumnMode
						? 'w-80 flex-shrink-0 h-full overflow-hidden border-r border-slate-200 dark:border-slate-700 flex flex-col'
						: (viewMode === 'list' ? 'w-full h-full overflow-hidden flex flex-col' : 'hidden')}
				>
					{@render changesList()}
				</div>

				<!-- Right panel: Diff viewer (like Files panel editor) -->
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

	<!-- Branch Manager Modal -->
	<BranchManager
		isOpen={showBranchManager}
		{branchInfo}
		onClose={() => showBranchManager = false}
		onSwitch={switchBranch}
		onCreate={createBranch}
		onDelete={deleteBranch}
		onRename={renameBranch}
		onMerge={mergeBranch}
		onRemotesChanged={loadRemotes}
	/>

	<!-- Conflict Resolver Modal -->
	<ConflictResolver
		isOpen={showConflictResolver}
		{conflictFiles}
		isLoading={isConflictLoading}
		onResolve={resolveConflict}
		onResolveWithAI={resolveWithAI}
		onAbortMerge={abortMerge}
		onClose={() => showConflictResolver = false}
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
