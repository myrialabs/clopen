<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { portal } from '$frontend/utils/portal';
	import { isMac } from '$frontend/utils/platform';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		commandPaletteState,
		closeCommandPalette,
		toggleCommandPalette
	} from '$frontend/stores/ui/command-palette.svelte';
	import { projectState, setCurrentProject } from '$frontend/stores/core/projects.svelte';
	import { setCurrentSession } from '$frontend/stores/core/sessions.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { openSettingsModal, settingsSections } from '$frontend/stores/ui/settings-modal.svelte';
	import { getCommandActions } from '$frontend/config/command-registry';
	import { revealFile } from '$frontend/stores/ui/file-peek.svelte';
	import { bestFuzzyScore } from '$frontend/utils/fuzzy';
	import { usageBoost, recordCommandUsage } from '$frontend/stores/ui/command-usage.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import { parseSnippet } from '$frontend/utils/fts-snippet';
	import type { ChatSession, Project } from '$shared/types/database/schema';
	import type { IconName } from '$shared/types/ui/icons';

	/** ChatSession plus a highlighted match snippet — set only for content matches. */
	type SessionSearchResult = ChatSession & { matchSnippet?: string };

	type ResultKind = 'project' | 'action' | 'setting' | 'session' | 'file';

	/** A file name match within the current project (from `files:search-files`). */
	interface FileHit {
		name: string;
		path: string;
		relativePath: string;
	}

	/** One icon+text chip in a PaletteItem's meta row (e.g. project, last active, message count). */
	interface PaletteItemMeta {
		icon: IconName;
		text: string;
	}

	interface PaletteItem {
		kind: ResultKind;
		id: string;
		label: string;
		description?: string;
		/** Trailing meta chips (project, last active, message count) — sessions only. */
		meta?: PaletteItemMeta[];
		/** Raw FTS snippet with sentinel markers around the matched text. */
		snippet?: string;
		icon: IconName;
		run: () => void | Promise<void>;
	}

	/** Mirrors HistoryView.svelte's getRelativeTime — kept local since it's a small, one-off formatter. */
	function getRelativeTime(dateString: string): string {
		const diffMs = Date.now() - new Date(dateString).getTime();
		const diffMins = Math.floor(diffMs / 1000 / 60);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffMins < 1) return 'Just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
		if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
		return `${Math.floor(diffDays / 365)}y ago`;
	}

	let query = $state('');
	let selectedIndex = $state(0);
	let inputEl = $state<HTMLInputElement>();
	let resultsEl = $state<HTMLElement>();
	let sessionResults = $state<SessionSearchResult[]>([]);
	let sessionsLoading = $state(false);
	let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let fileResults = $state<FileHit[]>([]);
	let filesLoading = $state(false);
	let fileDebounceTimer: ReturnType<typeof setTimeout> | undefined;

	const modifierLabel = isMac() ? '⌘' : 'Ctrl+';

	// Reset transient state every time the palette opens, and focus the input.
	$effect(() => {
		if (commandPaletteState.isOpen) {
			query = '';
			selectedIndex = 0;
			sessionResults = [];
			fileResults = [];
			queueMicrotask(() => inputEl?.focus());
		}
	});

	// `@` prefix scopes the palette to file results only; otherwise everything is
	// searched together and ranked. `effectiveQuery` strips the prefix so the
	// remaining categories still match naturally.
	const fileOnly = $derived(query.trimStart().startsWith('@'));
	const effectiveQuery = $derived((fileOnly ? query.trimStart().slice(1) : query).trim());

	function triggerSessionSearch(q: string) {
		clearTimeout(searchDebounceTimer);
		if (q.trim().length < 2) {
			sessionResults = [];
			sessionsLoading = false;
			return;
		}
		sessionsLoading = true;
		searchDebounceTimer = setTimeout(async () => {
			try {
				const result = await ws.http('sessions:search-global', { query: q.trim() });
				sessionResults = result.sessions;
			} catch (err) {
				debug.error('session', 'Global session search failed:', err);
				sessionResults = [];
			} finally {
				sessionsLoading = false;
			}
		}, 150);
	}

	$effect(() => {
		if (commandPaletteState.isOpen) triggerSessionSearch(fileOnly ? '' : effectiveQuery);
	});

	function triggerFileSearch(q: string) {
		clearTimeout(fileDebounceTimer);
		const project = projectState.currentProject;
		if (!project || q.trim().length < 2) {
			fileResults = [];
			filesLoading = false;
			return;
		}
		filesLoading = true;
		fileDebounceTimer = setTimeout(async () => {
			try {
				const hits = await ws.http('files:search-files', {
					project_path: project.path,
					query: q.trim()
				});
				fileResults = hits.slice(0, 8);
			} catch (err) {
				debug.error('file', 'Palette file search failed:', err);
				fileResults = [];
			} finally {
				filesLoading = false;
			}
		}, 150);
	}

	$effect(() => {
		if (commandPaletteState.isOpen) triggerFileSearch(effectiveQuery);
	});

	// Empty-state cap for actions — with layout presets and theme commands the
	// registry is long, so when nothing is typed we surface the most-used few
	// (usage-ranked) instead of dumping the whole list.
	const EMPTY_ACTION_LIMIT = 8;

	const matchedProjects = $derived.by(() => {
		if (fileOnly) return [];
		const q = effectiveQuery;
		if (!q) {
			const base = projectState.recentProjects.length
				? projectState.recentProjects
				: projectState.projects;
			return base.slice(0, 6);
		}
		return projectState.projects
			.map((p) => ({ p, match: bestFuzzyScore(q, [p.name, p.path]) }))
			.filter((x) => x.match > 0)
			.map((x) => ({ p: x.p, score: x.match + usageBoost(`project-${x.p.id}`) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, 6)
			.map((x) => x.p);
	});

	const matchedActions = $derived.by(() => {
		if (fileOnly) return [];
		const all = getCommandActions();
		const q = effectiveQuery;
		if (!q) {
			return [...all]
				.sort((a, b) => usageBoost(`action-${b.id}`) - usageBoost(`action-${a.id}`))
				.slice(0, EMPTY_ACTION_LIMIT);
		}
		return all
			.map((a) => ({ a, match: bestFuzzyScore(q, [a.label, a.description, ...(a.keywords ?? [])]) }))
			.filter((x) => x.match > 0)
			.map((x) => ({ a: x.a, score: x.match + usageBoost(`action-${x.a.id}`) }))
			.sort((x, y) => y.score - x.score)
			.map((x) => x.a);
	});

	const matchedSettings = $derived.by(() => {
		if (fileOnly) return [];
		const q = effectiveQuery;
		if (!q) return [];
		const visible = settingsSections.filter((s) => !s.adminOnly || authStore.isAdmin);
		return visible
			.map((s) => ({ s, match: bestFuzzyScore(q, [s.label, s.description]) }))
			.filter((x) => x.match > 0)
			.sort((x, y) => y.match - x.match)
			.map((x) => x.s);
	});

	async function selectProject(project: Project) {
		closeCommandPalette();
		await setCurrentProject(project);
	}

	async function selectSession(session: SessionSearchResult) {
		closeCommandPalette();
		const project = projectState.projects.find((p) => p.id === session.project_id);
		if (project && project.id !== projectState.currentProject?.id) {
			await setCurrentProject(project);
		}
		await setCurrentSession(session);
	}

	function selectFile(file: FileHit) {
		closeCommandPalette();
		revealFile(file.path);
	}

	// Flat, ordered list — drives both keyboard navigation and grouping below.
	const items = $derived.by(() => {
		const list: PaletteItem[] = [];

		for (const p of matchedProjects) {
			list.push({
				kind: 'project',
				id: `project-${p.id}`,
				label: p.name,
				description: p.path,
				icon: 'lucide:folder',
				run: () => selectProject(p)
			});
		}

		for (const a of matchedActions) {
			list.push({
				kind: 'action',
				id: `action-${a.id}`,
				label: a.label,
				description: a.description,
				icon: a.icon,
				run: a.run
			});
		}

		for (const s of matchedSettings) {
			list.push({
				kind: 'setting',
				id: `setting-${s.id}`,
				label: s.label,
				description: s.description,
				icon: s.icon,
				run: () => openSettingsModal(s.id)
			});
		}

		for (const file of fileResults) {
			list.push({
				kind: 'file',
				id: `file-${file.path}`,
				label: file.name,
				description: file.relativePath,
				icon: 'lucide:file',
				run: () => selectFile(file)
			});
		}

		for (const session of sessionResults) {
			const project = projectState.projects.find((p) => p.id === session.project_id);
			const lastActive = session.last_message_at || session.ended_at || session.started_at;
			const meta: PaletteItemMeta[] = [];
			if (project?.name) meta.push({ icon: 'lucide:folder', text: project.name });
			if (lastActive) meta.push({ icon: 'lucide:clock', text: getRelativeTime(lastActive) });
			if (session.message_count != null) {
				meta.push({ icon: 'lucide:message-circle', text: `${session.message_count} msgs` });
			}
			list.push({
				kind: 'session',
				id: `session-${session.id}`,
				label: session.title || session.head_title || 'Untitled session',
				description: session.matchSnippet ? undefined : session.head_summary || undefined,
				snippet: session.matchSnippet,
				meta,
				icon: 'lucide:message-square',
				run: () => selectSession(session)
			});
		}

		return list;
	});

	const indexedItems = $derived(items.map((item, index) => ({ ...item, index })));

	const groups = $derived.by(() => {
		const all = [
			{ label: 'Projects', items: indexedItems.filter((i) => i.kind === 'project') },
			{ label: 'Actions', items: indexedItems.filter((i) => i.kind === 'action') },
			{ label: 'Settings', items: indexedItems.filter((i) => i.kind === 'setting') },
			{ label: 'Files', items: indexedItems.filter((i) => i.kind === 'file') },
			{ label: 'Sessions', items: indexedItems.filter((i) => i.kind === 'session') }
		];
		return all.filter((g) => g.items.length > 0);
	});

	// Keep the selection valid as the result set shrinks/grows while typing.
	$effect(() => {
		if (selectedIndex >= items.length) selectedIndex = Math.max(0, items.length - 1);
	});

	async function activate(item: PaletteItem) {
		// Track usage so frequent/recent entries rank higher next time.
		recordCommandUsage(item.id);
		await item.run();
		if (item.kind === 'action' || item.kind === 'setting') {
			closeCommandPalette();
		}
	}

	/**
	 * Keep the highlighted row visible as arrow-key navigation moves past the
	 * fold. Only scrolls when the row is actually out of view — anchoring to
	 * the edge it's crossing (bottom when it overflows below, top when it
	 * overflows above) — instead of unconditionally calling scrollIntoView
	 * on every key press. Doing it unconditionally caused a jump on
	 * alternating Down/Up presses: the row would still be fully visible, but
	 * the previous direction's edge anchor would yank it back to the
	 * opposite edge anyway.
	 */
	function scrollSelectedIntoView() {
		requestAnimationFrame(() => {
			const el = resultsEl?.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement | null;
			if (!resultsEl || !el) return;
			const containerRect = resultsEl.getBoundingClientRect();
			const elRect = el.getBoundingClientRect();
			if (elRect.bottom > containerRect.bottom) {
				el.scrollIntoView({ block: 'end' });
			} else if (elRect.top < containerRect.top) {
				el.scrollIntoView({ block: 'start' });
			}
		});
	}

	/** Don't steal Ctrl/Cmd+K from the terminal — readline binds it to kill-line. */
	function isTerminalFocused(): boolean {
		const active = document.activeElement as HTMLElement | null;
		return !!active?.closest('.xterm');
	}

	// Registered on the capture phase (see onkeydowncapture below) so the
	// shortcut still reaches us even when focus is inside another modal —
	// Modal.svelte's content wrapper calls stopPropagation() on keydown during
	// the bubble phase, which would otherwise block a normal bubble listener.
	// When we do act on a key, we also stopPropagation() so it doesn't leak
	// through to whatever modal is open underneath the palette.
	function handleGlobalKeydown(event: KeyboardEvent) {
		const modifierPressed = isMac() ? event.metaKey : event.ctrlKey;

		if (!commandPaletteState.isOpen) {
			if (modifierPressed && event.key.toLowerCase() === 'k' && !isTerminalFocused()) {
				event.preventDefault();
				event.stopPropagation();
				toggleCommandPalette();
			}
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeCommandPalette();
			return;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			event.stopPropagation();
			if (items.length > 0) {
				selectedIndex = (selectedIndex + 1) % items.length;
				scrollSelectedIntoView();
			}
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			if (items.length > 0) {
				selectedIndex = (selectedIndex - 1 + items.length) % items.length;
				scrollSelectedIntoView();
			}
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			const item = items[selectedIndex];
			if (item) activate(item);
			return;
		}

		if (modifierPressed && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			event.stopPropagation();
			closeCommandPalette();
		}
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) closeCommandPalette();
	}
</script>

<svelte:window onkeydowncapture={handleGlobalKeydown} />

{#if commandPaletteState.isOpen}
	<div
		use:portal
		class="fixed inset-0 z-[200] bg-black/50 dark:bg-slate-950/70 backdrop-blur-sm flex items-start justify-center pt-[12vh] px-4"
		role="dialog"
		aria-modal="true"
		aria-label="Command palette"
		onclick={handleBackdropClick}
		in:fade={{ duration: 150, easing: cubicOut }}
		out:fade={{ duration: 100, easing: cubicOut }}
	>
		<div
			class="w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
			in:scale={{ duration: 150, easing: cubicOut, start: 0.97 }}
			out:scale={{ duration: 100, easing: cubicOut, start: 0.97 }}
		>
			<!-- Search Input -->
			<div class="flex items-center gap-3 px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<Icon name="lucide:search" class="w-4.5 h-4.5 text-slate-400 dark:text-slate-500 shrink-0" />
				<input
					bind:this={inputEl}
					bind:value={query}
					type="text"
					placeholder="Search projects, files, actions, settings, sessions..."
					class="flex-1 bg-transparent border-none outline-none text-slate-900 dark:text-slate-100 text-sm placeholder:text-slate-400 dark:placeholder:text-slate-500"
				/>
				{#if sessionsLoading || filesLoading}
					<div class="w-3.5 h-3.5 border-2 border-slate-300 border-t-violet-500 rounded-full animate-spin shrink-0"></div>
				{/if}
				<kbd class="text-3xs font-mono text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 shrink-0">Esc</kbd>
			</div>

			<!-- Results -->
			<div bind:this={resultsEl} class="flex-1 overflow-y-auto py-2">
				{#if items.length === 0}
					<div class="flex flex-col items-center gap-2 py-10 text-slate-500 dark:text-slate-500 text-sm">
						<Icon name="lucide:search-x" class="w-8 h-8 opacity-40" />
						<p>No results found</p>
					</div>
				{:else}
					{#each groups as group (group.label)}
						<div class="px-4 py-1 text-3xs font-semibold text-slate-500 dark:text-slate-500 uppercase tracking-wider mt-1.5 first:mt-0">
							{group.label}
						</div>
						{#each group.items as item (item.id)}
							<button
								type="button"
								data-index={item.index}
								class="flex items-center gap-3 w-[calc(100%-1rem)] mx-2 px-2.5 py-2 rounded-lg text-left bg-transparent border-none cursor-pointer transition-colors duration-100
									{item.index === selectedIndex
									? 'bg-violet-500/10 text-slate-900 dark:text-slate-100'
									: 'text-slate-700 dark:text-slate-300 hover:bg-slate-100/80 dark:hover:bg-slate-800/80'}"
								onmouseenter={() => (selectedIndex = item.index)}
								onclick={() => activate(item)}
							>
								<Icon
									name={item.icon}
									class="w-4 h-4 shrink-0 {item.index === selectedIndex
										? 'text-violet-600 dark:text-violet-400'
										: 'text-slate-400 dark:text-slate-500'}"
								/>
								<div class="flex-1 min-w-0">
									<span class="block text-sm font-medium truncate">{item.label}</span>
									{#if item.snippet}
										<p class="text-xs text-slate-400 dark:text-slate-500 truncate">
											{#each parseSnippet(item.snippet) as part}
												{#if part.hl}<mark class="bg-transparent text-violet-600 dark:text-violet-400 font-semibold">{part.text}</mark>{:else}{part.text}{/if}
											{/each}
										</p>
									{:else if item.description}
										<span class="block text-xs text-slate-400 dark:text-slate-500 truncate">{item.description}</span>
									{/if}
									{#if item.meta && item.meta.length > 0}
										<div class="flex items-center gap-1.5 text-3xs font-medium text-slate-500 dark:text-slate-400 truncate mt-0.5">
											{#each item.meta as m, i (m.icon + m.text)}
												{#if i > 0}<span class="opacity-40">·</span>{/if}
												<span class="flex items-center gap-1 truncate">
													<Icon name={m.icon} class="w-2.5 h-2.5 shrink-0" />
													<span class="truncate">{m.text}</span>
												</span>
											{/each}
										</div>
									{/if}
								</div>
							</button>
						{/each}
					{/each}
				{/if}
			</div>

			<!-- Footer Hints -->
			<div class="flex items-center gap-3 px-4 py-2 border-t border-slate-200 dark:border-slate-800 text-3xs text-slate-400 dark:text-slate-500 shrink-0">
				<span class="flex items-center gap-1"><kbd class="border border-slate-200 dark:border-slate-700 rounded px-1">↑↓</kbd> Navigate</span>
				<span class="flex items-center gap-1"><kbd class="border border-slate-200 dark:border-slate-700 rounded px-1">↵</kbd> Select</span>
				<span class="ml-auto flex items-center gap-1"><kbd class="border border-slate-200 dark:border-slate-700 rounded px-1">{modifierLabel}K</kbd> Toggle</span>
			</div>
		</div>
	</div>
{/if}
