<script lang="ts">
	/**
	 * A list you can search and tick several things in.
	 *
	 * A native `<select>` stops working somewhere around a dozen options: you
	 * cannot search it, you cannot see what is chosen without opening it, and it
	 * cannot express "several" without a modifier key nobody discovers. This is the
	 * replacement for the cases where the list is as long as the user's project
	 * count and picking two of them is a normal thing to want.
	 *
	 * The empty selection is a REAL state, not a placeholder for "everything". What
	 * it means is the caller's business — `emptyLabel` is how they say so — and the
	 * distinction matters because the two readings lead to opposite views.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	interface Option {
		id: string;
		label: string;
		/** Second line, for disambiguating options that share a name. */
		hint?: string;
	}

	interface Props {
		options: Option[];
		/** `null` means "not narrowed at all"; an array is an explicit choice. */
		selected: string[] | null;
		onChange: (selected: string[] | null) => void;
		/** Shown on the trigger when `selected` is null. */
		allLabel?: string;
		/** Shown on the trigger when `selected` is an empty array. */
		emptyLabel?: string;
		placeholder?: string;
		disabled?: boolean;
		class?: string;
	}

	const {
		options,
		selected,
		onChange,
		allLabel = 'All',
		emptyLabel = 'None',
		placeholder = 'Search…',
		disabled = false,
		class: className = ''
	}: Props = $props();

	let open = $state(false);
	let query = $state('');
	let root = $state<HTMLDivElement | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	const chosen = $derived(selected === null ? null : new Set(selected));
	const visible = $derived(
		query.trim()
			? options.filter(option =>
					`${option.label} ${option.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
				)
			: options
	);

	const summary = $derived.by(() => {
		if (selected === null) return allLabel;
		if (selected.length === 0) return emptyLabel;
		if (selected.length === 1) {
			return options.find(option => option.id === selected[0])?.label ?? '1 selected';
		}
		return `${selected.length} selected`;
	});

	function toggle(id: string): void {
		// `null` means every option is in scope, so the first tick has to start from
		// that full set — otherwise "deselect one" would silently become "select one".
		const base = selected === null ? options.map(option => option.id) : selected;
		onChange(base.includes(id) ? base.filter(value => value !== id) : [...base, id]);
	}

	function onPointerDown(event: PointerEvent): void {
		if (!open || !root || root.contains(event.target as Node)) return;
		open = false;
	}

	$effect(() => {
		if (!open) {
			query = '';
			return;
		}
		// Focus after the transition has put the element in the DOM.
		requestAnimationFrame(() => input?.focus());
	});
</script>

<svelte:window onpointerdown={onPointerDown} />

<div bind:this={root} class="relative {className}">
	<button
		type="button"
		{disabled}
		onclick={() => (open = !open)}
		class="flex items-center gap-1.5 w-full px-2 py-1.5 text-[11px] rounded-md border transition-colors
		       disabled:opacity-40 {open || (selected !== null)
			? 'border-violet-500/40 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
			: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100'}"
	>
		<Icon name="lucide:folder" class="w-3.5 h-3.5 shrink-0" />
		<span class="truncate">{summary}</span>
		<Icon name="lucide:chevron-down" class="w-3 h-3 ml-auto shrink-0 opacity-60" />
	</button>

	{#if open}
		<div
			class="absolute left-0 top-[calc(100%+4px)] z-40 w-[260px] max-w-[80vw] rounded-xl overflow-hidden
			       bg-white/95 dark:bg-slate-800/95 backdrop-blur-md ring-1 ring-slate-900/10 dark:ring-white/10
			       shadow-[0_16px_40px_-12px_rgba(15,23,42,0.35)] dark:shadow-[0_16px_40px_-12px_rgba(0,0,0,0.65)]"
			transition:fly={{ y: -8, duration: 150, easing: cubicOut }}
		>
			<div class="p-2 border-b border-slate-200/70 dark:border-slate-700/70">
				<input
					bind:this={input}
					bind:value={query}
					{placeholder}
					class="w-full px-2 py-1.5 text-[11px] rounded-md bg-slate-100/70 dark:bg-slate-900/50
					       text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none
					       focus:ring-1 focus:ring-violet-500"
				/>
			</div>

			<div class="flex items-center gap-3 px-3 py-1.5 border-b border-slate-200/70 dark:border-slate-700/70">
				<button
					type="button"
					onclick={() => onChange(null)}
					class="text-[10px] text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400"
				>
					{allLabel}
				</button>
				<button
					type="button"
					onclick={() => onChange([])}
					class="text-[10px] text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400"
				>
					{emptyLabel}
				</button>
			</div>

			<ul class="max-h-[240px] overflow-y-auto py-1">
				{#if visible.length === 0}
					<li class="px-3 py-2 text-[11px] text-slate-400">Nothing matched</li>
				{/if}
				{#each visible as option (option.id)}
					<li>
						<button
							type="button"
							onclick={() => toggle(option.id)}
							class="flex items-start gap-2 w-full text-left px-3 py-1.5
							       hover:bg-slate-100/70 dark:hover:bg-slate-700/50 transition-colors"
						>
							<span
								class="mt-[3px] w-3.5 h-3.5 rounded-[4px] border shrink-0 flex items-center justify-center
								       {chosen === null || chosen.has(option.id)
									? 'bg-violet-600 border-violet-600'
									: 'border-slate-300 dark:border-slate-600'}"
							>
								{#if chosen === null || chosen.has(option.id)}
									<Icon name="lucide:check" class="w-2.5 h-2.5 text-white" />
								{/if}
							</span>
							<span class="min-w-0">
								<span class="block text-[11px] leading-snug text-slate-700 dark:text-slate-200 break-words">
									{option.label}
								</span>
								{#if option.hint}
									<span class="block text-[9px] text-slate-400 truncate">{option.hint}</span>
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
