<script lang="ts">
	/**
	 * Per-binding behaviour: branch naming, and the two optional transitions.
	 *
	 * Both transitions default to "Do nothing" and the copy says so out loud.
	 * Moving someone else's ticket is visible to their whole team, and an
	 * integration that starts doing it because it was installed is one people
	 * disconnect.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import { DEFAULT_BRANCH_TEMPLATE } from '$shared/types/work';
	import type { WorkBindingConfig, WorkItemStateOption } from '$shared/types/work';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	// A modal stacked over the Issues & PRs surface rather than a band pushed into it:
	// this is settings, not content, and inserting it above the list shoved the
	// work items down the moment anyone looked at a branch template.
	let { isOpen = $bindable(), onClose }: Props = $props();

	const source = $derived(workStore.source);
	const config = $derived(source?.binding?.config ?? null);

	let branchTemplate = $state('');
	let onStartWork = $state<string>('');
	let onPrOpen = $state<string>('');
	let states = $state<WorkItemStateOption[]>([]);
	let saving = $state(false);

	// Seeded from the binding rather than bound to it: this form is a draft until
	// Save, so typing a template must not rename branches mid-edit.
	$effect(() => {
		const current = config;
		if (!current) return;
		branchTemplate = current.branchTemplate;
		onStartWork = current.transitionOnStartWork ?? '';
		onPrOpen = current.transitionOnPrOpen ?? '';
	});

	// Issue states, because both transitions act on the ISSUE — the one that was
	// started, or the one a pull request was opened for. Fetched here rather than
	// read off the store so the form works before any item has been opened, and
	// only while open so a closed dialog costs no request.
	$effect(() => {
		if (!isOpen) return;
		void workStore.fetchStates('issue').then((options) => {
			states = options;
		});
	});

	const preview = $derived(
		branchTemplate
			.replace(/\{kind\}/g, 'issue')
			.replace(/\{identifier\}/g, '128')
			.replace(/\{slug\}/g, 'sessions-drop-on-reconnect')
	);

	async function save() {
		saving = true;
		try {
			const next: WorkBindingConfig = {
				branchTemplate: branchTemplate.trim() || DEFAULT_BRANCH_TEMPLATE,
				transitionOnStartWork: onStartWork || null,
				transitionOnPrOpen: onPrOpen || null
			};
			await workStore.setConfig(next);
			onClose();
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:isOpen {onClose} title="Behaviour" size="md">
	{#snippet children()}
	<div class="flex flex-col gap-4">
		<label class="flex flex-col gap-1.5">
			<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Branch name</span>
			<input
				type="text"
				class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
				value={branchTemplate}
				onchange={(event) => (branchTemplate = event.currentTarget.value)}
				placeholder={DEFAULT_BRANCH_TEMPLATE}
			/>
			<span class="text-xs text-slate-500 dark:text-slate-400">
				<code>{'{kind}'}</code>, <code>{'{identifier}'}</code> and <code>{'{slug}'}</code> are replaced.
				Example: <code class="text-slate-700 dark:text-slate-300">{preview}</code>
			</span>
		</label>

		<label class="flex flex-col gap-1.5">
			<span class="text-xs font-medium text-slate-700 dark:text-slate-300">When work starts on an issue</span>
			<select
				class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
				value={onStartWork}
				onchange={(event) => (onStartWork = event.currentTarget.value)}
			>
				<option value="">Do nothing</option>
				{#each states as option (option.value)}
					<option value={option.value}>Move it to “{option.label}”</option>
				{/each}
			</select>
		</label>

		<label class="flex flex-col gap-1.5">
			<span class="text-xs font-medium text-slate-700 dark:text-slate-300">When a pull request is opened for it</span>
			<select
				class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
				value={onPrOpen}
				onchange={(event) => (onPrOpen = event.currentTarget.value)}
			>
				<option value="">Do nothing</option>
				{#each states as option (option.value)}
					<option value={option.value}>Move it to “{option.label}”</option>
				{/each}
			</select>
		</label>

		{#if states.length === 0}
			<p class="text-xs text-slate-500 dark:text-slate-400 m-0">
				This provider did not report any states, so transitions are unavailable.
			</p>
		{/if}

	</div>
	{/snippet}

	{#snippet footer()}
		<div class="flex items-center justify-end gap-2">
			<button
				type="button"
				class="h-9 px-3.5 text-sm font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-lg text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
				onclick={onClose}
			>
				Cancel
			</button>
			<button
				type="button"
				class="flex items-center gap-1.5 h-9 px-3.5 text-sm font-semibold bg-violet-600 hover:bg-violet-700 border-none rounded-lg text-white cursor-pointer disabled:opacity-50"
				disabled={saving}
				onclick={save}
			>
				{#if saving}
					<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
				{/if}
				Save
			</button>
		</div>
	{/snippet}
</Modal>
