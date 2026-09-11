<script lang="ts">
	/**
	 * Everything you can ADD, in one place.
	 *
	 * Split out of the hub deliberately. The main list answers "what do I have",
	 * and a catalogue of things you do NOT have sitting underneath it reads as
	 * part of that answer — the two look alike and mean opposite things. Behind a
	 * button, the separation is the user's own action instead of a heading they
	 * have to notice.
	 *
	 * The two MCP routes live here too, for the same reason: adding a curated
	 * provider, installing from the registry and pasting a config by hand are
	 * three answers to one question.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { CATEGORY_ICONS, CATEGORY_LABELS } from './capabilities';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import { getProviderIcon } from '$shared/constants/tool-icons';
	import { isDarkMode } from '$frontend/stores/ui/theme.svelte';
	import type { IntegrationProviderInfo } from '$shared/types/integrations';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		onConnect: (provider: IntegrationProviderInfo) => void;
		onBrowseRegistry: () => void;
		onAddManually: () => void;
	}

	const { isOpen, onClose, onConnect, onBrowseRegistry, onAddManually }: Props = $props();

	let search = $state('');

	/**
	 * EVERY provider, not only the unconnected ones.
	 *
	 * The account layer keys on `(provider, label)` and generates "GitHub 2" for
	 * a second one, so two accounts for the same service — a personal org and a
	 * work org, say — are supported and always were. Hiding a connected provider
	 * from this list was the only thing preventing it, which also made the
	 * connect dialog's "only needed if you connect more than one" a promise the
	 * UI refused to keep.
	 */
	const available = $derived.by(() => {
		const query = search.trim().toLowerCase();
		return integrationsStore.providers
			.filter(provider => !query || `${provider.name} ${provider.description}`.toLowerCase().includes(query));
	});

	/** How many accounts already exist for a provider, so the row can say so. */
	function connectedCount(providerId: string): number {
		return integrationsStore.accounts.filter(account => account.provider === providerId).length;
	}

	function brandMark(providerId: string): string | null {
		const icon = getProviderIcon(providerId);
		if (!icon) return null;
		return isDarkMode() ? icon.dark : icon.light;
	}
</script>

<Modal {isOpen} onClose={onClose} title="Add an integration" size="md">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<p class="text-xs text-slate-500 dark:text-slate-400">
				Connect once; every engine and project can use it.
			</p>

			{#if integrationsStore.providers.length > 4}
				<div class="relative">
					<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
						<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
						<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					</svg>
					<input
						type="text"
						bind:value={search}
						placeholder="Search integrations…"
						class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
					/>
				</div>
			{/if}

			{#if available.length === 0}
				<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">
					{search.trim() ? `Nothing matches "${search.trim()}".` : 'No providers are declared.'}
				</p>
			{:else}
				<div class="space-y-2">
					{#each available as provider (provider.id)}
						{@const mark = brandMark(provider.id)}
						{@const existing = connectedCount(provider.id)}
						<div class="flex items-center gap-3 p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
							{#if mark}
								<span class="w-6 h-6 shrink-0 [&>svg]:w-full [&>svg]:h-full">{@html mark}</span>
							{:else}
								<Icon name={CATEGORY_ICONS[provider.category]} class="w-6 h-6 shrink-0 text-slate-400" />
							{/if}
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="font-semibold text-slate-900 dark:text-slate-100">{provider.name}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">
										{CATEGORY_LABELS[provider.category]}
									</span>
									{#if existing > 0}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 shrink-0">
											{existing} connected
										</span>
									{/if}
								</div>
								<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{provider.description}</p>
							</div>
							<Button variant="outline" size="sm" class="shrink-0" onclick={() => onConnect(provider)}>
								{existing > 0 ? 'Add another' : 'Connect'}
							</Button>
						</div>
					{/each}
				</div>
			{/if}

			<div class="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
				<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Not listed?</p>
				<div class="flex flex-col gap-2">
					<Button variant="outline" size="sm" class="justify-start gap-2" onclick={onBrowseRegistry}>
						<Icon name="lucide:library" class="w-4 h-4" />
						Browse the MCP registry
					</Button>
					<Button variant="outline" size="sm" class="justify-start gap-2" onclick={onAddManually}>
						<Icon name="lucide:plus" class="w-4 h-4" />
						Add a connector manually
					</Button>
				</div>
			</div>
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={onClose}>Close</Button>
	{/snippet}
</Modal>
