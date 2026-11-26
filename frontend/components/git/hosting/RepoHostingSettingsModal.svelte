<script lang="ts">
	/**
	 * This repository's hosting settings — opened from the Git panel, because
	 * they belong to the project on screen, not to the app. Settings → Git
	 * Hosting stays global: accounts only.
	 *
	 * Two things live here. Which repository issues and pull requests come from
	 * (read off the remote; overridden only for a monorepo whose work lives
	 * elsewhere), and what starting work does — branch naming and the optional
	 * state transitions.
	 */
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import WorkBehaviourForm from '$frontend/components/work/WorkBehaviourForm.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import { hostingStore } from '$frontend/stores/features/hosting.svelte';
	import { openHostConnect } from '$frontend/stores/ui/host-connect.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	const { isOpen, onClose }: Props = $props();

	const source = $derived(workStore.source);
	const account = $derived(hostingStore.primaryAccount);

	let locatorDraft = $state('');
	let saving = $state(false);

	$effect(() => {
		if (!isOpen) return;
		locatorDraft = source?.binding?.locator ?? source?.suggestedLocators[0] ?? '';
	});

	async function saveLocator() {
		if (!locatorDraft.trim()) return;
		saving = true;
		try {
			await workStore.setBinding(locatorDraft.trim());
		} finally {
			saving = false;
		}
	}
</script>

<Modal {isOpen} {onClose} title="Repository settings" size="md">
	{#snippet children()}
		<div class="space-y-5 text-sm">
			{#if account}
				<div class="flex items-center gap-2 text-xs text-slate-500">
					<ProviderMark provider={account.provider} size="w-4 h-4" />
					<span class="flex-1 truncate">{account.label}{account.login ? ` · @${account.login}` : ''}</span>
					<button
						type="button"
						class="bg-transparent border-none p-0 text-xs text-violet-600 dark:text-violet-400 cursor-pointer"
						onclick={() => openHostConnect({ provider: account.provider, accountId: account.accountId })}
					>
						Sign in again
					</button>
				</div>
			{/if}

			{#if source}
				<div class="space-y-1.5">
					<span class="block text-xs font-medium text-slate-700 dark:text-slate-300">Issues and pull requests come from</span>
					<div class="flex gap-2">
						<input
							class="flex-1 min-w-0 px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
							bind:value={locatorDraft}
							list="repo-hosting-locators"
							placeholder="owner/repository"
						/>
						<datalist id="repo-hosting-locators">
							{#each source.suggestedLocators as locator (locator)}<option value={locator}></option>{/each}
						</datalist>
						<Button size="sm" loading={saving} disabled={!locatorDraft.trim() || locatorDraft.trim() === source.binding?.locator} onclick={saveLocator}>Save</Button>
					</div>
					<p class="m-0 text-[11px] text-slate-500">
						{source.binding?.detected ? 'Read from the git remote.' : source.binding ? 'Set here.' : 'Not matched yet.'}
						Change it only when this project's work lives in another repository.
					</p>
				</div>

				{#if source.binding}
					<div class="pt-4 border-t border-slate-200 dark:border-slate-800">
						<p class="m-0 mb-3 text-xs font-semibold text-slate-500">Starting work</p>
						<WorkBehaviourForm />
					</div>
				{/if}
			{:else}
				<p class="m-0 text-xs text-slate-500">Issues and pull requests are not available for this repository.</p>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={onClose}>Close</Button>
	{/snippet}
</Modal>
