<script lang="ts">
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import type { IconName } from '$shared/types/ui/icons';

	export type GitMoreAction =
		| 'merge-branch'
		| 'push-follow-tags'
		| 'push-all-tags'
		| 'push-force-lease'
		| 'push-force'
		| 'pull-rebase'
		| 'fetch-all'
		| 'undo-soft'
		| 'undo-mixed'
		| 'undo-hard'
		| 'revert-last'
		| 'npm-patch'
		| 'npm-minor'
		| 'npm-major'
		| 'clean-untracked'
		| 'gc';

	interface Props {
		disabled?: boolean;
		/** A "more" action is running — show a spinner and block the menu, like push/pull. */
		isBusy?: boolean;
		hasRemotes?: boolean;
		selectedRemote?: string;
		currentBranch?: string;
		onAction: (action: GitMoreAction) => void;
	}

	const {
		disabled = false,
		isBusy = false,
		hasRemotes = false,
		selectedRemote = 'origin',
		currentBranch,
		onAction
	}: Props = $props();

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
	}

	interface MenuSection {
		label: string;
		items: MenuItem[];
	}

	const sections: MenuSection[] = [
		{
			label: 'Push',
			items: [
				{ id: 'push-follow-tags', label: 'Push with tags', hint: '--follow-tags', command: 'git push --follow-tags', icon: 'lucide:tags', needsRemote: true },
				{ id: 'push-all-tags', label: 'Push all tags', hint: '--tags', command: 'git push --tags', icon: 'lucide:tag', needsRemote: true },
				{ id: 'push-force-lease', label: 'Force push (safe)', hint: '--force-with-lease', command: 'git push --force-with-lease', icon: 'lucide:shield-check', tone: 'danger', needsRemote: true },
				{ id: 'push-force', label: 'Force push', hint: '--force', command: 'git push --force', icon: 'lucide:zap', tone: 'danger', needsRemote: true }
			]
		},
		{
			label: 'Sync',
			items: [
				{ id: 'pull-rebase', label: 'Pull with rebase', hint: '--rebase', command: 'git pull --rebase', icon: 'lucide:git-pull-request-arrow', needsRemote: true },
				{ id: 'fetch-all', label: 'Fetch all & prune', hint: '--all --prune', command: 'git fetch --all --prune --tags', icon: 'lucide:refresh-cw', needsRemote: true }
			]
		},
		{
			label: 'Branch',
			items: [
				{ id: 'merge-branch', label: 'Merge Branch', command: 'git merge', icon: 'lucide:git-merge' }
			]
		},
		{
			label: 'Undo last commit',
			items: [
				{ id: 'undo-soft', label: 'Keep Staged', hint: '--soft HEAD~1', command: 'git reset --soft HEAD~1', icon: 'lucide:undo-2' },
				{ id: 'undo-mixed', label: 'Keep Changes', hint: '--mixed HEAD~1', command: 'git reset --mixed HEAD~1', icon: 'lucide:undo' },
				{ id: 'undo-hard', label: 'Discard Changes', hint: '--hard HEAD~1', command: 'git reset --hard HEAD~1', icon: 'lucide:trash-2', tone: 'danger' },
				{ id: 'revert-last', label: 'Revert last commit', hint: 'new commit', command: 'git revert --no-edit HEAD', icon: 'lucide:history' }
			]
		},
		{
			label: 'Release (npm version)',
			items: [
				{ id: 'npm-patch', label: 'npm version patch', hint: 'x.x.+1', command: 'npm version patch', icon: 'lucide:package' },
				{ id: 'npm-minor', label: 'npm version minor', hint: 'x.+1.0', command: 'npm version minor', icon: 'lucide:package' },
				{ id: 'npm-major', label: 'npm version major', hint: '+1.0.0', command: 'npm version major', icon: 'lucide:package' }
			]
		},
		{
			label: 'Maintenance',
			items: [
				{ id: 'clean-untracked', label: 'Clean untracked files', hint: '-fd', command: 'git clean -fd', icon: 'lucide:eraser', tone: 'danger' },
				{ id: 'gc', label: 'Optimize repository', hint: 'gc', command: 'git gc', icon: 'lucide:wrench' }
			]
		}
	];

	let isOpen = $state(false);
	let buttonEl: HTMLButtonElement | undefined = $state(undefined);
	let menuStyle = $state('');

	function toggle() {
		if (disabled || isBusy) return;
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

	function isItemDisabled(item: MenuItem): boolean {
		return Boolean(item.needsRemote && !hasRemotes);
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
				return `git pull --rebase ${remote} ${branch}`;
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
		return item.hint;
	}

	function handleSelect(item: MenuItem) {
		if (isItemDisabled(item)) return;
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
		disabled={disabled || isBusy}
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
			class="fixed w-60 max-h-[60vh] overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 py-1.5"
			style={menuStyle}
			role="menu"
			transition:scale={{ duration: 130, easing: cubicOut, start: 0.95, opacity: 0 }}
		>
			{#each sections as section, sectionIndex (section.label)}
				{#if sectionIndex > 0}
					<div class="my-1 mx-2 border-t border-slate-200 dark:border-slate-700/70"></div>
				{/if}
				<div class="px-3 py-1 text-3xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
					{section.label}
				</div>
				{#each section.items as item (item.id)}
					{@const itemDisabled = isItemDisabled(item)}
					{@const hint = hintFor(item)}
					<button
						type="button"
						role="menuitem"
						class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left bg-transparent border-none transition-colors
							{itemDisabled
								? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
								: item.tone === 'danger'
									? 'text-red-600 dark:text-red-400 hover:bg-red-500/10 cursor-pointer'
									: 'text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 cursor-pointer'}"
						onclick={() => handleSelect(item)}
						disabled={itemDisabled}
						title={itemDisabled ? 'No remote configured' : tooltipFor(item)}
					>
						<Icon name={item.icon} class="w-3.5 h-3.5 flex-shrink-0" />
						<span class="flex-1 text-xs font-medium truncate">{item.label}</span>
						{#if hint}
							<span class="text-3xs text-slate-400 dark:text-slate-500 font-mono flex-shrink-0">{hint}</span>
						{/if}
					</button>
				{/each}
			{/each}
		</div>
	{/if}
</div>
