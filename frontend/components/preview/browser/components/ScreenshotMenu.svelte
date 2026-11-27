<script lang="ts">
	/**
	 * The toolbar's screenshot control.
	 *
	 * The camera copies the page in one click — the thing done most often.
	 * The chevron opens everything else: where the picture goes, what it
	 * covers, and how it is saved. The choices are remembered per user, so the
	 * one click keeps doing what was last set up.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import {
		preferences,
		updatePreferences,
		type ScreenshotMenuAction
	} from '../core/screenshot-controller.svelte';

	let {
		disabled = false,
		busy = false,
		/** False while an agent holds the tab: a full-page capture would move the page under it. */
		fullPageAvailable = true,
		/** Whether the device on screen has a mockup to draw. */
		frameAvailable = false,
		onAction = (_action: ScreenshotMenuAction) => {}
	} = $props();

	let isOpen = $state(false);
	let rootElement = $state<HTMLDivElement | undefined>();

	const prefs = $derived(preferences());
	const fullPage = $derived(prefs.fullPage && fullPageAvailable);
	const scopeLabel = $derived(fullPage ? 'full page' : 'visible area');

	interface MenuItem {
		action: ScreenshotMenuAction;
		label: string;
		icon: IconName;
		enabled?: boolean;
	}

	const deliveries = $derived<MenuItem[]>([
		{ action: 'copy', label: 'Copy', icon: 'lucide:copy' },
		{ action: 'download', label: 'Download', icon: 'lucide:download' },
		{ action: 'save', label: 'Save to project', icon: 'lucide:folder-down' },
		{ action: 'annotate', label: 'Annotate…', icon: 'lucide:pencil-line' }
	]);

	const captures: MenuItem[] = [
		{ action: 'region', label: 'Select an area…', icon: 'lucide:crop' },
		{ action: 'element', label: 'Pick an element…', icon: 'lucide:square-dashed-mouse-pointer' },
		{ action: 'devices', label: 'All device sizes…', icon: 'lucide:monitor-smartphone' }
	];

	function run(action: ScreenshotMenuAction) {
		isOpen = false;
		onAction(action);
	}

	function handleWindowPointerDown(event: PointerEvent) {
		if (!isOpen || !rootElement) return;
		if (!rootElement.contains(event.target as Node)) isOpen = false;
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (isOpen && event.key === 'Escape') isOpen = false;
	}

	const buttonClass =
		'flex items-center justify-center text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-100 h-7';
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

<div bind:this={rootElement} class="relative flex items-center">
	<button
		type="button"
		onclick={() => onAction('copy')}
		{disabled}
		class="{buttonClass} w-7 rounded-l-md"
		title="Copy a screenshot ({scopeLabel})"
		aria-label="Copy a screenshot"
	>
		<Icon name={busy ? 'lucide:loader-circle' : 'lucide:camera'} class="h-4 w-4 {busy ? 'animate-spin' : ''}" />
	</button>
	<button
		type="button"
		onclick={() => (isOpen = !isOpen)}
		{disabled}
		class="{buttonClass} w-4 rounded-r-md {isOpen ? 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100' : ''}"
		title="Screenshot options"
		aria-label="Screenshot options"
		aria-haspopup="menu"
		aria-expanded={isOpen}
	>
		<Icon name="lucide:chevron-down" class="h-3 w-3" />
	</button>

	{#if isOpen}
		<div
			class="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900"
			role="menu"
		>
			<div class="px-3 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-slate-400">
				Screenshot · {scopeLabel}
			</div>
			{#each deliveries as item (item.action)}
				<button
					type="button"
					role="menuitem"
					onclick={() => run(item.action)}
					disabled={item.enabled === false}
					class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent dark:text-slate-200 dark:hover:bg-slate-800"
				>
					<Icon name={item.icon} class="h-4 w-4 shrink-0 text-slate-400" />
					<span class="min-w-0 truncate">{item.label}</span>
				</button>
			{/each}

			<div class="my-1 border-t border-slate-100 dark:border-slate-800"></div>

			{#each captures as item (item.action)}
				<button
					type="button"
					role="menuitem"
					onclick={() => run(item.action)}
					class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
				>
					<Icon name={item.icon} class="h-4 w-4 shrink-0 text-slate-400" />
					<span class="min-w-0 truncate">{item.label}</span>
				</button>
			{/each}

			<div class="my-1 border-t border-slate-100 dark:border-slate-800"></div>

			<div class="flex flex-col gap-2 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300">
				<label
					class="flex items-center justify-between gap-2 {fullPageAvailable ? '' : 'opacity-50'}"
					title={fullPageAvailable ? 'Capture the whole scrollable page' : 'Not available while an agent is using this tab'}
				>
					<span>Full page</span>
					<input
						type="checkbox"
						class="accent-violet-600"
						checked={fullPage}
						disabled={!fullPageAvailable}
						onchange={(event) => updatePreferences({ fullPage: event.currentTarget.checked })}
					/>
				</label>
				<label
					class="flex items-center justify-between gap-2 {frameAvailable && !fullPage ? '' : 'opacity-50'}"
					title={!frameAvailable
						? 'This device has no frame to draw'
						: fullPage
							? 'Only the visible area fits in a device frame'
							: 'Draw the device around the screenshot'}
				>
					<span>Device frame</span>
					<input
						type="checkbox"
						class="accent-violet-600"
						checked={prefs.deviceFrame}
						disabled={!frameAvailable || fullPage}
						onchange={(event) => updatePreferences({ deviceFrame: event.currentTarget.checked })}
					/>
				</label>
				<div class="flex items-center justify-between gap-2" title="Format for downloads and saves. Copies are always PNG.">
					<span>Format</span>
					<div class="flex overflow-hidden rounded-md border border-slate-200 dark:border-slate-700">
						{#each ['png', 'jpeg'] as const as format (format)}
							<button
								type="button"
								onclick={() => updatePreferences({ format })}
								class="px-2 py-0.5 text-2xs font-medium uppercase transition-colors {prefs.format === format
									? 'bg-violet-500 text-white'
									: 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}"
							>
								{format === 'jpeg' ? 'jpg' : format}
							</button>
						{/each}
					</div>
				</div>
				{#if prefs.format === 'jpeg'}
					<label class="flex items-center justify-between gap-2">
						<span>Quality</span>
						<span class="flex items-center gap-2">
							<input
								type="range"
								min="40"
								max="100"
								step="5"
								class="w-24 accent-violet-600"
								value={prefs.quality}
								onchange={(event) => updatePreferences({ quality: Number(event.currentTarget.value) })}
							/>
							<span class="w-7 text-right tabular-nums">{prefs.quality}</span>
						</span>
					</label>
				{/if}
				<label class="flex items-center justify-between gap-2" title="Folder inside the project that Save to project writes into">
					<span class="shrink-0">Project folder</span>
					<input
						type="text"
						value={prefs.folder}
						placeholder="screenshots"
						spellcheck="false"
						autocomplete="off"
						class="min-w-0 flex-1 rounded-md border border-slate-200 bg-transparent px-1.5 py-0.5 text-right text-xs outline-none focus:border-violet-400 dark:border-slate-700"
						onchange={(event) => updatePreferences({ folder: event.currentTarget.value.trim() || 'screenshots' })}
					/>
				</label>
			</div>
		</div>
	{/if}
</div>
