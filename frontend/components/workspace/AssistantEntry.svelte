<script lang="ts">
	/**
	 * The fixed rows at the top of the sidebar: Chat and Tasks (Clopen's two
	 * views) — plus what needs you and the Library where those have no button
	 * of their own. Which chat is open — and a new one — is chosen from the
	 * switcher on the chat itself. The same rows in the same order
	 * whether the sidebar is wide or narrow — narrow only hides the words.
	 * Rendered apart from the project list: Clopen is not a project among
	 * projects, so it is never sorted, pinned, archived or deleted with them.
	 */
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { isAssistantProject } from '$shared/utils/assistant-project';
	import type { Project } from '$shared/types/database/schema';
	import type { IconName } from '$shared/types/ui/icons';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { assistantView, openNeedsYou, setAssistantTab, type AssistantTab } from '$frontend/stores/ui/assistant-view.svelte';
	import { openLibrary } from '$frontend/stores/ui/library-modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface Props {
		/** The narrow icon-only sidebar. */
		collapsed?: boolean;
		/** Hide "Needs you" where it already has its own button (the header). */
		withNeedsYou?: boolean;
		/** Hide the Library where it already has its own button (the sidebar's footer). */
		withLibrary?: boolean;
		onSelect: (project: Project) => void;
		/** A row was picked (the phone menu closes). */
		onChat?: () => void;
	}

	const { collapsed = false, withNeedsYou = true, withLibrary = true, onSelect, onChat }: Props = $props();

	const assistant = $derived(projectState.projects.find(isAssistantProject) ?? null);
	const onClopen = $derived(Boolean(assistant) && projectState.currentProject?.id === assistant?.id);
	const working = $derived(assistantStore.runningTaskCount);
	const needsYou = $derived(assistantStore.needsYou.length);

	function open(tab: AssistantTab) {
		setAssistantTab(tab);
		if (assistant && !onClopen) onSelect(assistant);
		onChat?.();
	}



	interface Row {
		id: string;
		label: string;
		icon: IconName;
		active: boolean;
		badge: number;
		badgeTone: string;
		dot?: boolean;
		run: () => void;
	}

	const rows = $derived<Row[]>([
		{ id: 'chat', label: 'Chat', icon: 'lucide:message-circle', active: onClopen && assistantView.tab === 'chat', badge: 0, badgeTone: '', run: () => open('chat') },
		{ id: 'tasks', label: 'Tasks', icon: 'lucide:list-checks', active: onClopen && assistantView.tab === 'tasks', badge: 0, badgeTone: '', dot: working > 0, run: () => open('tasks') },
		...(withNeedsYou ? [{ id: 'needs', label: 'Needs you', icon: 'lucide:bell' as IconName, active: false, badge: needsYou, badgeTone: 'bg-amber-500', run: openNeedsYou }] : []),
		...(withLibrary ? [{ id: 'library', label: 'Library', icon: 'lucide:library' as IconName, active: false, badge: 0, badgeTone: '', run: () => openLibrary() }] : [])
	]);

	const base = 'relative flex items-center rounded-lg cursor-pointer transition-colors duration-150 border-none';
	// Narrow, these sit in the same rail as the footer's icons and look like them.
	const idle = $derived(
		collapsed
			? 'bg-transparent text-slate-500 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'
			: 'bg-transparent text-slate-600 dark:text-slate-400 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'
	);
	const current = 'bg-violet-500/10 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300';
</script>

<div class="flex flex-col {collapsed ? 'items-center gap-1' : 'gap-0.5'}">
	{#each rows as row (row.id)}
		<div class="relative group/row {collapsed ? '' : 'w-full'}">
			<button
				type="button"
				class="{base} {row.active ? current : idle} {collapsed ? 'justify-center w-9 h-9' : 'gap-2.5 w-full py-2 px-3 text-left text-sm'}"
				onclick={row.run}
				title={collapsed ? row.label : undefined}
				aria-label={row.badge ? `${row.label} (${row.badge})` : row.label}
				aria-current={row.active ? 'page' : undefined}
			>
				<Icon name={row.icon} class="w-5 h-5 shrink-0 {collapsed ? '' : 'mx-0.5'}" />
				{#if !collapsed}<span class="flex-1 font-medium">{row.label}</span>{/if}
				{#if row.dot}
					<span class="{collapsed ? 'absolute top-1.5 right-1.5' : ''} w-2 h-2 rounded-full bg-emerald-500 animate-pulse" title="Working"></span>
				{/if}
				{#if row.badge > 0}
					<span class="{collapsed ? 'absolute -top-0.5 -right-0.5' : ''} min-w-5 h-5 px-1.5 rounded-full {row.badgeTone} text-white text-2xs font-bold flex items-center justify-center">{row.badge}</span>
				{/if}
			</button>
		</div>
	{/each}
</div>
