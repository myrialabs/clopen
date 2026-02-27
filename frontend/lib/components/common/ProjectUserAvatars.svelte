<script lang="ts">
	import AvatarBubble from './AvatarBubble.svelte';
	import type { ProjectStatus } from '$frontend/lib/services/project';

	interface UserData {
		userId: string;
		userName: string;
	}

	interface Props {
		projectStatus: ProjectStatus | undefined;
		maxVisible?: number;
	}

	const { projectStatus, maxVisible = 3 }: Props = $props();

	let showAllUsers = $state(false);
	let containerEl = $state<HTMLDivElement | null>(null);

	const activeUsers = $derived((projectStatus?.activeUsers || []) as UserData[]);
	const visibleUsers = $derived(activeUsers.slice(0, maxVisible));
	const overflowCount = $derived(Math.max(0, activeUsers.length - maxVisible));

	const tooltipText = $derived(activeUsers.length > 0
		? `Active: ${activeUsers.map((u: UserData) => u.userName).join(', ')}`
		: 'No active users');

	function toggleShowAll(e: MouseEvent) {
		e.stopPropagation();
		showAllUsers = !showAllUsers;
	}

	function handleClickOutside(e: MouseEvent) {
		if (containerEl && !containerEl.contains(e.target as Node)) {
			showAllUsers = false;
		}
	}

	$effect(() => {
		if (showAllUsers) {
			document.addEventListener('click', handleClickOutside, true);
			return () => document.removeEventListener('click', handleClickOutside, true);
		}
	});
</script>

{#if activeUsers.length > 0}
	<div class="relative" bind:this={containerEl}>
		<button onclick={toggleShowAll} class="flex items-center -space-x-1.5 min-w-0 -my-1" title={tooltipText}>
			{#each visibleUsers as user}
				<AvatarBubble {user} size="sm" />
			{/each}

			{#if overflowCount > 0}
				<span
					class="w-6 h-6 rounded-full bg-gradient-to-br from-slate-500 to-slate-600 dark:from-slate-600 dark:to-slate-700 flex items-center justify-center text-xs font-bold text-white border-2 border-white dark:border-slate-800 shadow-sm z-10 cursor-pointer hover:from-slate-400 hover:to-slate-500 transition-all"
				>
					+{overflowCount}
				</span>
			{/if}
		</button>

		<!-- All users popover -->
		{#if showAllUsers}
			<div
				class="absolute top-full right-0 mt-2 py-2 px-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 min-w-[160px]"
			>
				<div class="px-2 pb-1.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">
					Active users ({activeUsers.length})
				</div>
				{#each activeUsers as user}
					<div class="flex items-center gap-2 px-2 py-1.5 rounded-md">
						<AvatarBubble {user} size="sm" showName={true} />
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
