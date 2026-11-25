<script lang="ts">
	/**
	 * Per project: what Clopen keeps for it, beside the size of its own folder,
	 * and the cleanups that can be narrowed to it. The folder is the user's and is
	 * only ever measured here; nothing on this page deletes inside it.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { StorageProjectEntry } from '$shared/types/storage';
	import { formatBytes, storageStore } from '$frontend/stores/features/storage.svelte';
	import CleanupActionRow from './CleanupActionRow.svelte';
	import { formatRelative } from './storage-copy';

	type SortKey = 'clopen' | 'folder' | 'name' | 'activity';

	let search = $state('');
	let sortKey = $state<SortKey>('clopen');
	let expanded = $state<string | null>(null);

	const folders = $derived(storageStore.folders);

	function folderBytes(projectId: string): number {
		const folder = folders[projectId];
		return folder?.state === 'ready' ? folder.sizeBytes : -1;
	}

	const projects = $derived.by(() => {
		const query = search.trim().toLowerCase();
		const list = (storageStore.report?.projects ?? []).filter(project =>
			!query || project.name.toLowerCase().includes(query) || project.path.toLowerCase().includes(query)
		);
		return [...list].sort((a, b) => {
			switch (sortKey) {
				case 'name':
					return a.name.localeCompare(b.name);
				case 'activity':
					return (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
				case 'folder':
					return folderBytes(b.projectId) - folderBytes(a.projectId);
				default:
					return b.bytes - a.bytes;
			}
		});
	});

	const maxBytes = $derived(Math.max(1, ...(storageStore.report?.projects ?? []).map(project => project.bytes)));

	const BREAKDOWN: Array<{ key: keyof StorageProjectEntry['breakdown']; label: string; color: string }> = [
		{ key: 'chats', label: 'Chats', color: 'bg-violet-500' },
		{ key: 'engineTranscripts', label: 'Engine transcripts', color: 'bg-blue-500' },
		{ key: 'snapshots', label: 'Checkpoints', color: 'bg-amber-500' },
		{ key: 'worktrees', label: 'Worktrees', color: 'bg-emerald-500' },
		{ key: 'previewProfiles', label: 'Preview browser', color: 'bg-pink-500' }
	];
</script>

<div class="flex flex-col gap-2">
	<div class="flex items-center gap-2">
		<div class="relative flex-1 min-w-0">
			<Icon name="lucide:search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
			<input
				type="text"
				bind:value={search}
				placeholder="Search projects..."
				aria-label="Search projects"
				class="w-full pl-9 pr-3 py-1.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
			/>
		</div>
		<select
			bind:value={sortKey}
			aria-label="Sort projects"
			class="shrink-0 px-3 py-1.5 text-sm font-semibold rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer"
		>
			<option value="clopen">Most Clopen data</option>
			<option value="folder">Largest folder</option>
			<option value="activity">Recently active</option>
			<option value="name">Name A–Z</option>
		</select>
	</div>

	{#if projects.length === 0}
		<p class="px-1 py-3 text-xs text-slate-500">
			{search.trim() ? `No projects match "${search.trim()}"` : 'No projects yet'}
		</p>
	{:else}
		<!-- Scrolls inside its own box: sixty projects should not make the whole
		     settings page long. -->
		<div class="flex flex-col gap-1.5 max-h-[26rem] overflow-y-auto pr-0.5">
			{#each projects as project (project.projectId)}
				{@const folder = folders[project.projectId]}
				{@const open = expanded === project.projectId}
				<!-- shrink-0: in a height-capped flex column, rows with overflow-hidden
				     would otherwise shrink to their borders instead of scrolling. -->
				<div class="shrink-0 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
					<button
						type="button"
						class="block w-full px-3.5 py-2.5 text-left cursor-pointer"
						aria-expanded={open}
						onclick={() => (expanded = open ? null : project.projectId)}
					>
						<div class="flex items-center gap-3">
							<Icon name="lucide:chevron-right" class="w-4 h-4 text-slate-400 shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
							<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate min-w-0 flex-1">{project.name}</span>
							<span class="text-xs font-mono text-slate-500 shrink-0 whitespace-nowrap" title="The project folder itself">
								{#if folder?.state === 'ready'}
									folder {folder.truncated ? '≥' : ''}{formatBytes(folder.sizeBytes)}
								{:else if folder?.state === 'measuring'}
									folder measuring…
								{:else if folder}
									folder unavailable
								{:else}
									folder —
								{/if}
							</span>
							<span class="text-sm font-semibold font-mono text-slate-900 dark:text-slate-100 shrink-0 whitespace-nowrap" title="Data Clopen keeps for this project">
								{formatBytes(project.bytes)}
							</span>
						</div>
						<!-- On its own line, full width: every row's bar spans the same track,
						     so lengths compare across projects. Beside the sizes, its width
						     followed whatever the size text needed. -->
						<div class="mt-2 ml-7 h-1 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden flex">
							{#each BREAKDOWN as part (part.key)}
								{#if project.breakdown[part.key] > 0}
									<div class="{part.color} h-full" style="width: {(project.breakdown[part.key] / maxBytes) * 100}%"></div>
								{/if}
							{/each}
						</div>
					</button>

					{#if open}
						<div class="border-t border-slate-200 dark:border-slate-700/60 bg-white/60 dark:bg-slate-900/30">
							<!-- One column on a narrow pane: two side by side cut every label
							     and pushed sizes onto a second line. -->
							<div class="grid grid-cols-1 @md:grid-cols-2 @2xl:grid-cols-3 gap-x-5 gap-y-1.5 px-4 pt-3">
								{#each BREAKDOWN as part (part.key)}
									<div class="flex items-center gap-2 min-w-0">
										<span class="w-2 h-2 rounded-full shrink-0 {part.color}"></span>
										<span class="text-xs text-slate-600 dark:text-slate-400 truncate">{part.label}</span>
										<span class="text-xs font-mono font-semibold text-slate-800 dark:text-slate-200 ml-auto shrink-0 whitespace-nowrap">{formatBytes(project.breakdown[part.key])}</span>
									</div>
								{/each}
							</div>
							<div class="px-4 pt-2 pb-3 text-2xs text-slate-500">
								<div>
									{project.sessionCount} chat{project.sessionCount === 1 ? '' : 's'}{project.slimmedSessionCount ? ` (${project.slimmedSessionCount} slimmed)` : ''}
									· {project.worktreeCount} worktree{project.worktreeCount === 1 ? '' : 's'}
									· active {formatRelative(project.lastActivityAt)}
								</div>
								<div class="font-mono truncate" title={project.path}>{project.path}</div>
							</div>
							<div class="divide-y divide-slate-200 dark:divide-slate-700/60 border-t border-slate-200 dark:border-slate-700/60">
								<CleanupActionRow action="slim-old-chats" projectId={project.projectId} defaultDays={30} />
								<CleanupActionRow action="delete-old-chats" projectId={project.projectId} defaultDays={90} />
								{#if project.worktreeCount > 0}
									<CleanupActionRow action="stale-worktrees" projectId={project.projectId} defaultDays={30} />
								{/if}
								{#if project.breakdown.previewProfiles > 0}
									<CleanupActionRow action="project-profiles" projectId={project.projectId} />
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
