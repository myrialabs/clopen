<script lang="ts">
	/**
	 * One thing Clopen needs from the owner, answered right here: a question
	 * (options or a reply), an approval, a link to connect a service, or a field
	 * for a key — which goes to the encrypted vault, never to the AI.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { InboxItem } from '$shared/types/assistant';
	import { relativeTime } from './format';

	interface Props {
		item: InboxItem;
		compact?: boolean;
	}

	const { item, compact = false }: Props = $props();

	let reply = $state('');
	let values = $state<Record<string, string>>({});
	let busy = $state(false);
	let shown = $state<Record<string, boolean>>({});

	const card = $derived(String(item.data.card ?? (item.kind === 'approval' ? 'approve' : item.kind === 'stalled' ? 'stuck' : 'ask')));
	const options = $derived(Array.isArray(item.data.options) ? (item.data.options as string[]) : []);
	const fields = $derived(Array.isArray(item.data.fields) ? (item.data.fields as Array<{ name: string; label: string; secret: boolean }>) : []);
	const url = $derived(typeof item.data.url === 'string' ? item.data.url : null);

	async function act(run: () => Promise<string | void>) {
		busy = true;
		try {
			const text = await run();
			if (text) addNotification({ type: 'success', title: text, message: '' });
		} catch (error) {
			addNotification({ type: 'error', title: 'That did not work', message: error instanceof Error ? error.message : String(error) });
		} finally {
			busy = false;
		}
	}

	const answer = (text: string) => act(() => assistantStore.answerCard(item.id, text));
	const approve = (approved: boolean) => act(async () => (await assistantStore.approve(item.id, approved)).text);
	const saveSecret = () =>
		act(() => assistantStore.fillSecretCard(item.id, Object.fromEntries(fields.map((field) => [field.name, values[field.name] ?? '']))));

	const icon = $derived(card === 'connect' ? 'lucide:plug' : card === 'secret' ? 'lucide:key-round' : card === 'approve' ? 'lucide:shield-check' : card === 'stuck' ? 'lucide:triangle-alert' : 'lucide:message-circle-question-mark');
	const field = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm outline-none focus:border-violet-500/60';
	const primary = 'shrink-0 px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50';
	const secondary = 'px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent text-sm text-slate-700 dark:text-slate-300 cursor-pointer hover:border-violet-500/40 disabled:opacity-50';
</script>

{#snippet secretInput(entry: { name: string; label: string; secret: boolean })}
	<div class="relative flex-1 min-w-0">
		<input
			class="{field} {entry.secret ? 'pr-9' : ''}"
			type={entry.secret && !shown[entry.name] ? 'password' : 'text'}
			placeholder={entry.label}
			aria-label={entry.label}
			autocomplete="off"
			bind:value={values[entry.name]}
		/>
		{#if entry.secret}
			<button type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 bg-transparent border-none cursor-pointer" onclick={() => (shown[entry.name] = !shown[entry.name])} aria-label={shown[entry.name] ? 'Hide' : 'Show'}>
				<Icon name={shown[entry.name] ? 'lucide:eye-off' : 'lucide:eye'} class="w-3.5 h-3.5" />
			</button>
		{/if}
	</div>
{/snippet}

<article class="relative rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm {compact ? 'p-3' : 'p-4'}">
	<button
		type="button"
		class="absolute top-2 right-2 flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 bg-transparent border-none cursor-pointer"
		onclick={() => act(() => assistantStore.resolveInbox(item.id, 'dismissed'))}
		aria-label="Dismiss"
		title="Dismiss"
	><Icon name="lucide:x" class="w-4 h-4" /></button>

	<div class="flex items-start gap-3 pr-7">
		<span class="flex items-center justify-center w-8 h-8 rounded-full shrink-0 bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400">
			<Icon name={icon} class="w-4 h-4" />
		</span>
		<div class="flex-1 min-w-0 pt-0.5">
			<p class="text-sm font-semibold text-slate-900 dark:text-slate-100 break-words">{item.title}</p>
			{#if item.body && card !== 'connect' && !compact}
				<p class="mt-0.5 text-sm text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{item.body}</p>
			{/if}
			<p class="mt-0.5 text-2xs text-slate-400">{relativeTime(item.createdAt)}</p>
		</div>
	</div>

	<div class="mt-3 {compact ? '' : 'pl-11'}">
		{#if card === 'connect' && url}
			<a href={url} target="_blank" rel="noopener" class="{primary} inline-flex items-center gap-1.5 no-underline">
				<Icon name="lucide:external-link" class="w-4 h-4" /> Connect
			</a>
		{:else if card === 'secret'}
			<form class="space-y-2" onsubmit={(event) => { event.preventDefault(); void saveSecret(); }}>
				{#if fields.length === 1}
					<div class="flex gap-2">
						{@render secretInput(fields[0])}
						<button type="submit" class={primary} disabled={busy || !values[fields[0].name]?.trim()}>Save</button>
					</div>
					<p class="flex items-center gap-1 text-2xs text-slate-400"><Icon name="lucide:lock" class="w-3 h-3" /> Stored encrypted</p>
				{:else}
					{#each fields as entry (entry.name)}{@render secretInput(entry)}{/each}
					<div class="flex items-center justify-between gap-2">
						<p class="flex items-center gap-1 text-2xs text-slate-400"><Icon name="lucide:lock" class="w-3 h-3" /> Stored encrypted</p>
						<button type="submit" class={primary} disabled={busy || fields.some((entry) => !values[entry.name]?.trim())}>Save</button>
					</div>
				{/if}
			</form>
		{:else if card === 'approve'}
			<div class="flex gap-2">
				<button type="button" class={primary} disabled={busy} onclick={() => approve(true)}>Approve</button>
				<button type="button" class={secondary} disabled={busy} onclick={() => approve(false)}>Decline</button>
			</div>
		{:else}
			{#if options.length}
				<div class="flex flex-wrap gap-1.5 mb-2">
					{#each options as option (option)}
						<button type="button" class={secondary} disabled={busy} onclick={() => answer(option)}>{option}</button>
					{/each}
				</div>
			{/if}
			<form class="flex gap-2" onsubmit={(event) => { event.preventDefault(); if (reply.trim()) void answer(reply.trim()).then(() => (reply = '')); }}>
				<input class={field} placeholder={card === 'stuck' ? 'How should it continue?' : 'Your answer…'} bind:value={reply} />
				<button type="submit" class={primary} disabled={busy || !reply.trim()}>Send</button>
			</form>
		{/if}
	</div>
</article>
