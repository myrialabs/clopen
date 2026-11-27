<script lang="ts">
	/**
	 * The ways to fund Clopen, from shared/constants/support.ts.
	 *
	 * Crypto comes first and every coin is equal — Clopen's users are global,
	 * and the one link method (Saweria) only takes Indonesian payments, so it
	 * sits underneath as a regional option rather than the main call.
	 *
	 * One address is shown at a time: four full addresses with four QR codes is
	 * a wall nobody reads. The address is never truncated — someone pasting it
	 * into a wallet should be able to check it character by character — and the
	 * network sits right next to it, because the same address on the wrong
	 * chain loses the money.
	 *
	 * `compact` is the strip at the foot of the What's new dialog: the same
	 * picker and address, with the QR code behind a button so the dialog keeps
	 * its height.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import TunnelQRCode from '$frontend/components/tunnel/TunnelQRCode.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { CRYPTO_SUPPORT_METHODS, LINK_SUPPORT_METHODS } from '$shared/constants/support';

	interface Props {
		compact?: boolean;
	}

	const { compact = false }: Props = $props();

	let selectedId = $state(CRYPTO_SUPPORT_METHODS[0].id);
	let qrOpen = $state(false);
	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	const selected = $derived(CRYPTO_SUPPORT_METHODS.find(method => method.id === selectedId) ?? CRYPTO_SUPPORT_METHODS[0]);

	function select(id: typeof selectedId) {
		selectedId = id;
		copied = false;
	}

	async function copyAddress() {
		const ok = await copyText(selected.address);
		if (!ok) {
			addNotification({ type: 'error', title: 'Could not copy', message: 'Select the address and copy it manually.' });
			return;
		}
		copied = true;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => { copied = false; }, 2000);
	}
</script>

{#snippet coinPicker()}
	<div class="inline-flex flex-wrap gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg" role="tablist" aria-label="Coin">
		{#each CRYPTO_SUPPORT_METHODS as method (method.id)}
			<button
				type="button"
				role="tab"
				aria-selected={selectedId === method.id}
				onclick={() => select(method.id)}
				class="px-2.5 py-0.5 text-xs font-semibold rounded-md transition-colors cursor-pointer
				{selectedId === method.id ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
			>
				{method.symbol}
			</button>
		{/each}
	</div>
{/snippet}

{#snippet addressRow()}
	<div class="flex items-start gap-1 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700/60">
		<code class="flex-1 min-w-0 break-all font-mono text-xs leading-relaxed text-slate-700 dark:text-slate-300 select-all">
			{selected.address}
		</code>
		<button
			type="button"
			onclick={copyAddress}
			class="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer
			{copied
				? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
				: 'text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400'}"
			aria-label="Copy {selected.symbol} address"
		>
			<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
			{copied ? 'Copied' : 'Copy'}
		</button>
		{#if compact}
			<button
				type="button"
				onclick={() => (qrOpen = !qrOpen)}
				aria-expanded={qrOpen}
				aria-label={qrOpen ? 'Hide QR code' : 'Show QR code'}
				class="shrink-0 inline-flex items-center justify-center w-7 h-6 rounded-md transition-colors cursor-pointer
				{qrOpen
					? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
					: 'text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400'}"
			>
				<Icon name="lucide:qr-code" class="w-3.5 h-3.5" />
			</button>
		{/if}
	</div>
{/snippet}

{#snippet networkWarning()}
	<p class="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
		<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 shrink-0 mt-px" />
		Send only {selected.symbol} on {selected.network}. Anything sent on another network is lost.
	</p>
{/snippet}

{#if compact}
	<div class="flex flex-col gap-2">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
				<Icon name="lucide:heart" class="w-4 h-4 text-rose-500" />
				Support Clopen
			</div>
			{@render coinPicker()}
		</div>
		<p class="text-xs text-slate-600 dark:text-slate-400">
			Clopen is free and open source. Donations pay for the time that goes into releases like this one.
		</p>
		{@render addressRow()}
		{#if qrOpen}
			<div class="flex justify-center">
				<TunnelQRCode value={selected.address} size={132} />
			</div>
		{/if}
		<div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
			{@render networkWarning()}
			{#each LINK_SUPPORT_METHODS as method (method.id)}
				<a
					href={method.url}
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
				>
					In {method.region}? <span class="font-semibold">{method.name}</span>
					<Icon name="lucide:external-link" class="w-3 h-3" />
				</a>
			{/each}
		</div>
	</div>
{:else}
	<div class="@container rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
		<div class="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5">
			<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Crypto</div>
			{@render coinPicker()}
		</div>

		<div class="flex flex-col @md:flex-row @md:items-center gap-4 px-4 py-3.5">
			<div class="flex-1 min-w-0 flex flex-col gap-2">
				<div class="flex items-center gap-2 flex-wrap">
					<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{selected.name}</span>
					<span class="px-1.5 py-0.5 rounded text-2xs font-semibold bg-violet-500/10 text-violet-600 dark:text-violet-400">
						{selected.network}
					</span>
				</div>
				{@render addressRow()}
				{@render networkWarning()}
			</div>

			<div class="shrink-0 self-center">
				<TunnelQRCode value={selected.address} size={132} />
			</div>
		</div>

		{#each LINK_SUPPORT_METHODS as method (method.id)}
			<a
				href={method.url}
				target="_blank"
				rel="noopener noreferrer"
				class="flex items-center gap-3 px-4 py-2.5 border-t border-slate-200 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
			>
				<div class="flex-1 min-w-0 text-xs text-slate-600 dark:text-slate-400">
					<span class="font-semibold text-slate-800 dark:text-slate-200">In {method.region}?</span>
					{method.name} takes {method.detail}.
				</div>
				<span class="inline-flex items-center gap-1 text-xs font-semibold text-violet-600 dark:text-violet-400 shrink-0">
					{method.name}
					<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
				</span>
			</a>
		{/each}
	</div>
{/if}
