<script lang="ts">
	/**
	 * One URL, one copy button, one QR code — the shape every "hand this to
	 * another device" surface needs.
	 *
	 * Five places grew their own version of this (Remote Access, Invites, the
	 * tunnel list, tunnel Settings, file shares), and they drifted: three
	 * dialects of the same row, two of them without the QR caption, and — the
	 * part that actually broke — four of them calling
	 * `navigator.clipboard.writeText()` directly. That API only exists in a
	 * SECURE CONTEXT, and these surfaces are precisely the ones opened over
	 * plain HTTP on a LAN address or a VPS IP, where the copy button silently
	 * did nothing. Going through `copyText()` here fixes all of them at once.
	 *
	 * Layout is ONE bordered card: the URL row, an optional meta line, and the
	 * QR panel separated by a rule rather than floated into a second box.
	 * Stacking bordered boxes is what made the earlier version read as three
	 * unrelated widgets in a narrow modal.
	 *
	 * The QR mode is a prop rather than a fixed choice because both behaviours
	 * are right: a link generated on demand (Remote Access, a file share) shows
	 * its code immediately, while a list of standing links (invites, tunnel
	 * hostnames) would be a wall of QR codes if they all did.
	 */
	import type { Snippet } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import TunnelQRCode from '$frontend/components/tunnel/TunnelQRCode.svelte';
	import { copyText } from '$frontend/utils/clipboard';

	interface Props {
		/** The URL that is copied and encoded into the QR code. */
		url: string;
		/** Shown instead of the raw URL — a hostname, for instance. */
		display?: string;
		/** `always`: QR is open. `toggle`: behind a button. `off`: no QR. */
		qr?: 'always' | 'toggle' | 'off';
		/** Caption under the QR code. */
		caption?: string;
		/** Render the URL as a link that opens in a new tab. */
		linkify?: boolean;
		/** Drop the card's own border — for callers that already draw one. */
		flat?: boolean;
		/** QR edge length in px. */
		qrSize?: number;
		/** Extra buttons on the URL row — revoke, remove, stop. */
		actions?: Snippet;
		/** A line under the URL row: countdown, target service, badges. */
		meta?: Snippet;
		onCopied?: (ok: boolean) => void;
	}

	const {
		url,
		display,
		qr = 'toggle',
		caption,
		linkify = false,
		flat = false,
		qrSize = 168,
		actions,
		meta,
		onCopied
	}: Props = $props();

	let copied = $state(false);
	let qrOpen = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	const showQR = $derived(qr === 'always' || (qr === 'toggle' && qrOpen));
	const label = $derived(display || url);

	async function copy() {
		const ok = await copyText(url);
		onCopied?.(ok);
		if (!ok) return;
		copied = true;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => { copied = false; }, 2000);
	}
</script>

<div
	class="overflow-hidden rounded-lg {flat
		? 'bg-slate-50 dark:bg-slate-800/60'
		: 'border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'}"
>
	<!-- `pb-0.5` when a meta line follows: the row's own bottom padding plus the
	     meta's leading otherwise reads as a paragraph break inside one card. -->
	<div class="flex items-center gap-2 px-3 pt-2 {meta ? 'pb-0.5' : 'pb-2'}">
		{#if linkify}
			<a
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				class="flex-1 min-w-0 truncate font-mono text-xs text-violet-600 dark:text-violet-400 hover:underline"
				title={url}
			>
				{label}
			</a>
		{:else}
			<div
				class="flex-1 min-w-0 truncate font-mono text-xs text-slate-600 dark:text-slate-400 select-all"
				title={url}
			>
				{label}
			</div>
		{/if}

			<!-- One group, tight spacing: these are halves of the same control strip,
		     and a full gap between them reads as unrelated buttons. -->
		<div class="flex items-center gap-0.5 shrink-0">
			<button
				type="button"
				onclick={copy}
				class="flex items-center justify-center w-7 h-7 rounded-md transition-all cursor-pointer
					{copied
					? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
					: 'hover:bg-violet-100 dark:hover:bg-violet-900/30 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400'}"
				title="Copy link"
				aria-label="Copy link"
			>
				<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
			</button>

			{#if qr === 'toggle'}
				<button
					type="button"
					onclick={() => (qrOpen = !qrOpen)}
					class="flex items-center justify-center w-7 h-7 rounded-md transition-all cursor-pointer
						{qrOpen
						? 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400'
						: 'hover:bg-violet-100 dark:hover:bg-violet-900/30 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400'}"
					title={qrOpen ? 'Hide QR code' : 'Show QR code'}
					aria-label={qrOpen ? 'Hide QR code' : 'Show QR code'}
					aria-expanded={qrOpen}
				>
					<Icon name="lucide:qr-code" class="w-3.5 h-3.5" />
				</button>
			{/if}

			{@render actions?.()}
		</div>
	</div>

	{#if meta}
		<div class="flex items-center gap-1.5 flex-wrap px-3 pb-2 leading-tight text-2xs text-slate-500 dark:text-slate-400">
			{@render meta()}
		</div>
	{/if}

	{#if showQR}
		<div
			class="flex flex-col items-center gap-0.5 px-3 py-2 border-t border-slate-200 dark:border-slate-700/70 bg-slate-50 dark:bg-slate-800/40"
		>
			<TunnelQRCode value={url} size={qrSize} />
			<p class="text-xs text-slate-500 dark:text-slate-400">
				{caption ?? "Scan with the other device's camera"}
			</p>
		</div>
	{/if}
</div>
