<script lang="ts">
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import type { IconName } from '$shared/types/ui/icons';
	import type { GitOpFlags } from '$frontend/stores/features/git-workspace.svelte';

	export type GitMoreAction =
		| 'amend-no-edit'
		| 'amend-message'
		| 'pull-merge'
		| 'pull-rebase'
		| 'pull-ff-only'
		| 'sync'
		| 'fetch-remote'
		| 'fetch-all'
		| 'push-follow-tags'
		| 'push-all-tags'
		| 'merge-branch'
		| 'rebase-onto'
		| 'return-to-branch'
		| 'set-upstream'
		| 'prune-merged'
		| 'prune-gone'
		| 'undo-soft'
		| 'undo-mixed'
		| 'revert-last'
		| 'npm-patch'
		| 'npm-minor'
		| 'npm-major'
		| 'stash-apply'
		| 'stash-untracked'
		| 'reflog'
		| 'submodule-update'
		| 'gc'
		| 'force-pull'
		| 'push-force-lease'
		| 'push-force'
		| 'undo-hard'
		| 'clean-untracked'
		| 'clean-ignored';

	interface Props {
		disabled?: boolean;
		/** A "more" action is running — show a spinner on the trigger, like push/pull. */
		isBusy?: boolean;
		hasRemotes?: boolean;
		selectedRemote?: string;
		currentBranch?: string;
		/**
		 * Why an operation of this kind cannot start right now, from the shared
		 * operation lock (any tab, any device). Null when it can.
		 */
		busyReasonFor?: (flag: keyof GitOpFlags) => string | null;
		/** An in-progress merge/rebase/cherry-pick/revert/bisect, if any. */
		operation?: string | null;
		/** HEAD is detached — there is no branch to act on. */
		detached?: boolean;
		/** The repo root has a package.json, so `npm version` can run. */
		hasPackageJson?: boolean;
		/** The repo declares submodules. */
		hasSubmodules?: boolean;
		/** The menu belongs to a nested repo, not the workspace's own. */
		isNested?: boolean;
		/** Files staged in this repo — amending without any changes nothing. */
		stagedCount?: number;
		/** The commit box has text, which "Amend message" uses. */
		hasCommitMessage?: boolean;
		onAction: (action: GitMoreAction) => void;
	}

	const {
		disabled = false,
		isBusy = false,
		hasRemotes = false,
		selectedRemote = 'origin',
		currentBranch,
		busyReasonFor,
		operation = null,
		detached = false,
		hasPackageJson = false,
		hasSubmodules = false,
		isNested = false,
		stagedCount = 0,
		hasCommitMessage = false,
		onAction
	}: Props = $props();

	/**
	 * What an action needs from the repository's state:
	 * `branch`  — a checked-out branch and no operation in progress;
	 * `settled` — no operation in progress (a detached HEAD is fine);
	 * `none`    — anything goes (read-only, or network-only).
	 */
	type Requirement = 'branch' | 'settled' | 'none';

	interface MenuItem {
		id: GitMoreAction;
		label: string;
		/** Muted text shown on the right of the row. */
		hint?: string;
		/** Full underlying command, shown in the native tooltip. */
		command: string;
		icon: IconName;
		tone?: 'default' | 'danger';
		needsRemote?: boolean;
		/** The busy flag this action holds — and is refused by. */
		flag?: keyof GitOpFlags;
		requires?: Requirement;
	}

	interface MenuSection {
		label: string;
		items: MenuItem[];
	}

	const sections: MenuSection[] = [
		{
			label: 'Commit',
			items: [
				{ id: 'amend-no-edit', label: 'Amend last commit', hint: 'keep message', command: 'git commit --amend --no-edit', icon: 'lucide:git-commit-horizontal', flag: 'isCommitting', requires: 'branch' },
				{ id: 'amend-message', label: 'Amend with new message', hint: 'from the box', command: 'git commit --amend -m <message>', icon: 'lucide:pencil-line', flag: 'isCommitting', requires: 'branch' }
			]
		},
		{
			label: 'Sync',
			items: [
				{ id: 'sync', label: 'Sync', hint: 'pull + push', command: 'git pull && git push', icon: 'lucide:arrow-down-up', needsRemote: true, flag: 'isPulling', requires: 'branch' },
				{ id: 'pull-merge', label: 'Pull with merge', hint: '--no-rebase', command: 'git pull --no-rebase', icon: 'lucide:git-merge', needsRemote: true, flag: 'isPulling', requires: 'branch' },
				{ id: 'pull-rebase', label: 'Pull with rebase', hint: '--rebase', command: 'git pull --rebase --autostash', icon: 'lucide:git-pull-request-arrow', needsRemote: true, flag: 'isPulling', requires: 'branch' },
				{ id: 'pull-ff-only', label: 'Pull fast-forward only', hint: '--ff-only', command: 'git pull --ff-only', icon: 'lucide:fast-forward', needsRemote: true, flag: 'isPulling', requires: 'branch' },
				{ id: 'fetch-remote', label: 'Fetch', hint: 'selected remote', command: 'git fetch', icon: 'lucide:cloud-download', needsRemote: true, flag: 'isFetching' },
				{ id: 'fetch-all', label: 'Fetch all & prune', hint: '--all --prune', command: 'git fetch --all --prune --tags', icon: 'lucide:refresh-cw', needsRemote: true, flag: 'isFetching' }
			]
		},
		{
			label: 'Push',
			items: [
				{ id: 'push-follow-tags', label: 'Push with tags', hint: '--follow-tags', command: 'git push --follow-tags', icon: 'lucide:tags', needsRemote: true, flag: 'isPushing', requires: 'branch' },
				{ id: 'push-all-tags', label: 'Push all tags', hint: '--tags', command: 'git push --tags', icon: 'lucide:tag', needsRemote: true, flag: 'isPushing' }
			]
		},
		{
			label: 'Branch',
			items: [
				// One entry only: the merge modal already offers default / --no-ff /
				// --squash, so listing the modes here as well would be two routes to
				// the same choice.
				{ id: 'merge-branch', label: 'Merge Branch', command: 'git merge', icon: 'lucide:git-merge', flag: 'isMoreBusy', requires: 'branch' },
				{ id: 'rebase-onto', label: 'Rebase onto Branch', hint: '--autostash', command: 'git rebase --autostash', icon: 'lucide:git-pull-request-arrow', flag: 'isMoreBusy', requires: 'branch' },
				{ id: 'return-to-branch', label: 'Return to Previous Branch', hint: 'checkout -', command: 'git checkout -', icon: 'lucide:corner-up-left', flag: 'isMoreBusy', requires: 'settled' },
				{ id: 'set-upstream', label: 'Branch Upstream…', hint: 'where it pushes', command: 'git branch --set-upstream-to', icon: 'lucide:git-compare-arrows', flag: 'isConfiguring', requires: 'branch' },
				{ id: 'prune-merged', label: 'Prune merged branches…', hint: '--merged', command: 'git branch --merged <default> → git branch -D', icon: 'lucide:scissors', flag: 'isBranching' },
				{ id: 'prune-gone', label: 'Prune gone branches…', hint: 'upstream deleted', command: 'git branch -D <branches whose upstream is gone>', icon: 'lucide:list-x', flag: 'isBranching' }
			]
		},
		{
			label: 'Undo last commit',
			items: [
				{ id: 'undo-soft', label: 'Keep Staged', hint: '--soft HEAD~1', command: 'git reset --soft HEAD~1', icon: 'lucide:undo-2', flag: 'isMoreBusy', requires: 'branch' },
				{ id: 'undo-mixed', label: 'Keep Changes', hint: '--mixed HEAD~1', command: 'git reset --mixed HEAD~1', icon: 'lucide:undo', flag: 'isMoreBusy', requires: 'branch' },
				{ id: 'revert-last', label: 'Revert last commit', hint: 'new commit', command: 'git revert --no-edit HEAD', icon: 'lucide:history', flag: 'isMoreBusy', requires: 'branch' }
			]
		},
		{
			label: 'Release (npm version)',
			items: [
				{ id: 'npm-patch', label: 'npm version patch', hint: 'x.x.+1', command: 'npm version patch', icon: 'lucide:package', flag: 'isMoreBusy', requires: 'branch' },
				{ id: 'npm-minor', label: 'npm version minor', hint: 'x.+1.0', command: 'npm version minor', icon: 'lucide:package', flag: 'isMoreBusy', requires: 'branch' },
				{ id: 'npm-major', label: 'npm version major', hint: '+1.0.0', command: 'npm version major', icon: 'lucide:package', flag: 'isMoreBusy', requires: 'branch' }
			]
		},
		{
			label: 'Recovery',
			items: [
				{ id: 'stash-untracked', label: 'Stash incl. untracked…', hint: '-u', command: 'git stash push --include-untracked', icon: 'lucide:archive', flag: 'isStashing', requires: 'settled' },
				{ id: 'stash-apply', label: 'Apply stash (keep entry)', hint: 'apply', command: 'git stash apply', icon: 'lucide:layers', flag: 'isStashing', requires: 'settled' },
				{ id: 'reflog', label: 'Browse reflog', hint: 'recover commits', command: 'git reflog', icon: 'lucide:history' }
			]
		},
		{
			label: 'Maintenance',
			items: [
				{ id: 'submodule-update', label: 'Update submodules', hint: '--init --recursive', command: 'git submodule update --init --recursive', icon: 'lucide:boxes', flag: 'isMoreBusy', requires: 'settled' },
				{ id: 'gc', label: 'Optimize repository', hint: 'gc', command: 'git gc', icon: 'lucide:wrench', flag: 'isMoreBusy' }
			]
		},
		{
			// Everything that destroys work, together and last, so none of it sits
			// one row away from a harmless action of the same family.
			label: 'Danger zone',
			items: [
				{ id: 'force-pull', label: 'Force pull', hint: 'reset to remote', command: 'git fetch && git reset --hard <upstream>', icon: 'lucide:arrow-down-to-line', tone: 'danger', needsRemote: true, flag: 'isPulling', requires: 'branch' },
				{ id: 'push-force-lease', label: 'Force push (safe)', hint: '--force-with-lease', command: 'git push --force-with-lease', icon: 'lucide:shield-check', tone: 'danger', needsRemote: true, flag: 'isPushing', requires: 'branch' },
				{ id: 'push-force', label: 'Force push', hint: '--force', command: 'git push --force', icon: 'lucide:zap', tone: 'danger', needsRemote: true, flag: 'isPushing', requires: 'branch' },
				{ id: 'undo-hard', label: 'Undo last commit & discard', hint: '--hard HEAD~1', command: 'git reset --hard HEAD~1', icon: 'lucide:trash-2', tone: 'danger', flag: 'isMoreBusy', requires: 'branch' },
				{ id: 'clean-untracked', label: 'Clean untracked files…', hint: '-fd', command: 'git clean -fd', icon: 'lucide:eraser', tone: 'danger', flag: 'isMoreBusy', requires: 'settled' },
				{ id: 'clean-ignored', label: 'Clean untracked & ignored…', hint: '-fdx', command: 'git clean -fdx', icon: 'lucide:brush-cleaning', tone: 'danger', flag: 'isMoreBusy', requires: 'settled' }
			]
		}
	];

	/**
	 * Actions that cannot run in this repository at all are left out rather than
	 * shown disabled: a menu that offers `npm version` in a repo without a
	 * package.json advertises something that will never work.
	 */
	function isItemHidden(item: MenuItem): boolean {
		if (item.id.startsWith('npm-')) return !hasPackageJson;
		if (item.id === 'submodule-update') return !hasSubmodules;
		// The upstream editor is scoped to the workspace's own repository.
		if (item.id === 'set-upstream') return isNested;
		return false;
	}

	const visibleSections = $derived(
		sections
			.map(section => ({ ...section, items: section.items.filter(item => !isItemHidden(item)) }))
			.filter(section => section.items.length > 0)
	);

	let isOpen = $state(false);
	let buttonEl: HTMLButtonElement | undefined = $state(undefined);
	let menuStyle = $state('');

	function toggle() {
		if (disabled) return;
		if (!isOpen && buttonEl) {
			const rect = buttonEl.getBoundingClientRect();
			const menuHeight = 320;
			menuStyle = window.innerHeight - rect.bottom < menuHeight && rect.top > menuHeight
				? `right: ${window.innerWidth - rect.right}px; bottom: ${window.innerHeight - rect.top + 6}px;`
				: `right: ${window.innerWidth - rect.right}px; top: ${rect.bottom + 6}px;`;
		}
		isOpen = !isOpen;
	}

	function close() {
		isOpen = false;
	}

	/**
	 * Why an item cannot be chosen right now, or null. Shown as its tooltip, so
	 * a greyed-out row always says what would make it available.
	 */
	function unavailableReason(item: MenuItem): string | null {
		if (item.needsRemote && !hasRemotes) return 'No remote configured';
		const requires = item.requires ?? 'none';
		if (requires !== 'none' && operation) {
			return `A ${operation} is in progress — continue or abort it first`;
		}
		if (requires === 'branch' && detached) return 'HEAD is detached — check out a branch first';
		if (item.id === 'amend-no-edit' && stagedCount === 0) return 'Stage the changes to add to the last commit first';
		if (item.id === 'amend-message' && !hasCommitMessage) return 'Type the new message in the commit box first';
		return item.flag ? (busyReasonFor?.(item.flag) ?? null) : null;
	}

	// Full command shown in the tooltip. Remote-targeting actions are resolved
	// against the currently-selected remote/branch (from the dock header / Branches
	// modal) so the tooltip reflects what will actually run — not a generic default.
	function fullCommand(item: MenuItem): string {
		const remote = selectedRemote || 'origin';
		const branch = currentBranch || '<branch>';
		switch (item.id) {
			case 'push-follow-tags':
				return `git push ${remote} ${branch} --follow-tags -u`;
			case 'push-all-tags':
				return `git push ${remote} --tags`;
			case 'push-force-lease':
				return `git push ${remote} ${branch} --force-with-lease -u`;
			case 'push-force':
				return `git push ${remote} ${branch} --force -u`;
			case 'pull-rebase':
				return `git pull --rebase --autostash ${remote} ${branch}`;
			case 'pull-merge':
				return `git pull --no-rebase ${remote} ${branch}`;
			case 'pull-ff-only':
				return `git pull --ff-only ${remote} ${branch}`;
			case 'fetch-remote':
				return `git fetch ${remote} --prune`;
			case 'force-pull':
				return `git fetch ${remote} ${branch} && git reset --hard FETCH_HEAD (local changes stashed first)`;
			default:
				return item.command;
		}
	}

	// The merge target is the current branch (the source branch is picked in the
	// modal that opens), so resolve its tooltip/hint to the real branch name
	// instead of a literal `<branch>` placeholder — consistent with the other rows.
	function tooltipFor(item: MenuItem): string {
		if (item.id === 'merge-branch') {
			return `Merge a branch into ${currentBranch || 'the current branch'}`;
		}
		return `${item.label} — ${fullCommand(item)}`;
	}

	function hintFor(item: MenuItem): string | undefined {
		if (item.id === 'merge-branch') return currentBranch ? `→ ${currentBranch}` : undefined;
		if (item.id === 'fetch-remote') return selectedRemote;
		return item.hint;
	}

	function handleSelect(item: MenuItem) {
		if (unavailableReason(item)) return;
		isOpen = false;
		onAction(item.id);
	}
</script>

<div class="relative flex-shrink-0" use:clickOutside={close}>
	<button
		bind:this={buttonEl}
		type="button"
		class="flex items-center justify-center w-8 h-7 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0
			{isOpen ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : ''}"
		onclick={toggle}
		{disabled}
		aria-haspopup="menu"
		aria-expanded={isOpen}
		title={isBusy ? 'Running git action…' : 'More git actions'}
	>
		{#if isBusy}
			<div class="w-3.5 h-3.5 border-2 border-slate-300/30 border-t-slate-500 rounded-full animate-spin flex-shrink-0"></div>
		{:else}
			<Icon name="lucide:ellipsis-vertical" class="w-3.5 h-3.5 flex-shrink-0" />
		{/if}
	</button>

	{#if isOpen}
		<div
			class="fixed w-64 max-h-[60vh] overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 py-1.5"
			style={menuStyle}
			role="menu"
			transition:scale={{ duration: 130, easing: cubicOut, start: 0.95, opacity: 0 }}
		>
			{#each visibleSections as section, sectionIndex (section.label)}
				{#if sectionIndex > 0}
					<div class="my-1 mx-2 border-t border-slate-200 dark:border-slate-700/70"></div>
				{/if}
				<div
					class="px-3 py-1 text-3xs font-semibold uppercase tracking-wider
						{section.label === 'Danger zone' ? 'text-red-500/80 dark:text-red-400/80' : 'text-slate-400 dark:text-slate-500'}"
				>
					{section.label}
				</div>
				{#each section.items as item (item.id)}
					{@const reason = unavailableReason(item)}
					{@const hint = hintFor(item)}
					<button
						type="button"
						role="menuitem"
						class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left bg-transparent border-none transition-colors
							{reason
								? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
								: item.tone === 'danger'
									? 'text-red-600 dark:text-red-400 hover:bg-red-500/10 cursor-pointer'
									: 'text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 cursor-pointer'}"
						onclick={() => handleSelect(item)}
						disabled={Boolean(reason)}
						title={reason ?? tooltipFor(item)}
					>
						<Icon name={item.icon} class="w-3.5 h-3.5 flex-shrink-0" />
						<span class="flex-1 text-xs font-medium truncate">{item.label}</span>
						{#if hint}
							<span class="text-3xs text-slate-400 dark:text-slate-500 font-mono flex-shrink-0 max-w-20 truncate">{hint}</span>
						{/if}
					</button>
				{/each}
			{/each}
		</div>
	{/if}
</div>
