<script lang="ts">
	/**
	 * The device-flow step: a code to type, where to type it, and how long is left.
	 *
	 * The code is the largest thing in the dialog on purpose — it is the one
	 * thing the user has to carry to another tab. "Open and copy" does both in
	 * one click, because opening the page first and then coming back for the
	 * code is the usual way people lose their place.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import type { DeviceFlowStart } from '$shared/types/git-hosting';

	interface Props {
		flow: DeviceFlowStart;
		serviceName: string;
		onCancel: () => void;
	}

	const { flow, serviceName, onCancel }: Props = $props();

	let now = $state(Date.now());
	let copied = $state(false);

	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const remainingMs = $derived(Math.max(0, new Date(flow.expiresAt).getTime() - now));
	const remaining = $derived(
		`${Math.floor(remainingMs / 60000)}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0')}`
	);
	const target = $derived(flow.verificationUriComplete ?? flow.verificationUri);

	async function copyCode() {
		copied = await copyText(flow.userCode);
		if (copied) setTimeout(() => (copied = false), 1500);
	}

	async function openAndCopy() {
		await copyCode();
		window.open(target, '_blank', 'noopener,noreferrer');
	}
</script>

<div class="flex flex-col items-center gap-3 p-4 rounded-xl border border-violet-500/30 bg-violet-500/5 text-center">
	<p class="text-xs text-slate-600 dark:text-slate-300 m-0">
		Enter this code on {serviceName} to let Clopen sign in.
	</p>
	<button
		type="button"
		class="font-mono text-2xl font-bold tracking-[0.25em] px-4 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 cursor-pointer hover:border-violet-500/50"
		onclick={copyCode}
		title="Copy the code"
	>
		{flow.userCode}
	</button>
	<div class="flex flex-wrap items-center justify-center gap-2">
		<button
			type="button"
			class="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-semibold rounded-lg bg-violet-600 hover:bg-violet-700 text-white border-none cursor-pointer"
			onclick={openAndCopy}
		>
			<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
			Copy code and open {serviceName}
		</button>
		<button
			type="button"
			class="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-lg bg-transparent border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800"
			onclick={copyCode}
		>
			<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
			{copied ? 'Copied' : 'Copy'}
		</button>
	</div>
	<div class="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
		<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
		<span>Waiting for you to approve · expires in {remaining}</span>
		<button
			type="button"
			class="bg-transparent border-none p-0 text-[11px] underline underline-offset-2 text-slate-500 cursor-pointer hover:text-slate-700 dark:hover:text-slate-300"
			onclick={onCancel}
		>
			Cancel
		</button>
	</div>
</div>
