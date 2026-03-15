<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getModifierKey } from '$frontend/utils/platform';

	interface Props {
		onClose: () => void;
	}

	let { onClose }: Props = $props();

	const mod = getModifierKey(); // ⌘ on Mac, Ctrl on Win/Linux

	const sections = [
		{
			title: 'Query',
			shortcuts: [
				{ keys: [mod, '↵'], description: 'Execute active query' },
				{ keys: [mod, 'Shift', '↵'], description: 'Explain query execution plan' },
			]
		},
		{
			title: 'Navigation',
			shortcuts: [
				{ keys: [mod, 'P'], description: 'Quick table search' },
				{ keys: [mod, 'I'], description: 'Toggle ERD diagram' },
				{ keys: [mod, 'Shift', 'F'], description: 'Global database search' },
				{ keys: [mod, 'Shift', 'H'], description: 'Health dashboard' },
				{ keys: [mod, 'Shift', 'M'], description: 'Process manager' },
				{ keys: [mod, 'Shift', 'B'], description: 'Backup panel' },
				{ keys: [mod, 'Shift', 'R'], description: 'REST API generator' },
				{ keys: [mod, '1–9'], description: 'Switch to connection by index' },
			]
		},
		{
			title: 'Interface',
			shortcuts: [
				{ keys: ['?'], description: 'Toggle this shortcut guide' },
				{ keys: ['Esc'], description: 'Close panel / modal' },
			]
		},
	] as const;

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	class="fixed inset-0 z-[210] flex items-center justify-center p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="shortcut-guide-title"
	in:fade={{ duration: 150 }}
	out:fade={{ duration: 100 }}
>
	<!-- Backdrop -->
	<div
		class="absolute inset-0 bg-black/50 backdrop-blur-sm"
		onclick={onClose}
		onkeydown={(e) => e.key === 'Escape' && onClose()}
		role="button"
		tabindex="-1"
		aria-label="Close shortcut guide"
	></div>

	<!-- Panel -->
	<div
		class="relative z-10 w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden"
		in:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
		out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
	>
		<!-- Header -->
		<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
			<div class="flex items-center gap-2.5">
				<div class="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center" aria-hidden="true">
					<Icon name="lucide:keyboard" class="w-4 h-4 text-violet-600" />
				</div>
				<h2 id="shortcut-guide-title" class="text-sm font-semibold text-slate-900 dark:text-slate-100">
					Keyboard Shortcuts
				</h2>
			</div>
			<button
				type="button"
				onclick={onClose}
				class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				aria-label="Close shortcut guide"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>

		<!-- Shortcut sections -->
		<div class="p-5 space-y-5">
			{#each sections as section}
				<div>
					<h3 class="text-3xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2.5">
						{section.title}
					</h3>
					<div class="space-y-2">
						{#each section.shortcuts as shortcut}
							<div class="flex items-center justify-between gap-4">
								<span class="text-xs text-slate-600 dark:text-slate-400">{shortcut.description}</span>
								<div class="flex items-center gap-0.5 shrink-0" aria-label={shortcut.keys.join(' + ')}>
									{#each shortcut.keys as key, ki}
										{#if ki > 0}
											<span class="text-3xs text-slate-300 dark:text-slate-600 mx-0.5" aria-hidden="true">+</span>
										{/if}
										<kbd class="px-1.5 py-0.5 text-3xs font-mono bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-600 dark:text-slate-400">
											{key}
										</kbd>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>

		<!-- Footer -->
		<div class="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
			<p class="text-3xs text-slate-400 dark:text-slate-500 text-center">
				Press <kbd class="font-mono px-1 py-0.5 bg-slate-200 dark:bg-slate-700 rounded text-slate-500 dark:text-slate-400">?</kbd> anywhere in Database Manager to toggle this guide
			</p>
		</div>
	</div>
</div>
