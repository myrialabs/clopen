<script lang="ts">
	/**
	 * Secrets — passwords, tokens and keys, encrypted on this machine. Clopen
	 * saves one the moment you give it, and uses it by name from then on; you
	 * can add, replace or delete them here, and show or copy a value when you
	 * need it yourself. The AI never sees a value — only its name.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import { relativeTime } from '$frontend/components/assistant/format';

	let adding = $state(false);
	let name = $state('');
	let value = $state('');
	let description = $state('');
	let saving = $state(false);
	let revealed = $state<Record<string, string>>({});

	async function reveal(secretName: string) {
		if (revealed[secretName] !== undefined) {
			const { [secretName]: _hidden, ...rest } = revealed;
			revealed = rest;
			return;
		}
		const shown = await assistantStore.revealSecret(secretName).catch(() => null);
		if (shown !== null) revealed = { ...revealed, [secretName]: shown };
	}

	async function copy(secretName: string) {
		const shown = revealed[secretName] ?? (await assistantStore.revealSecret(secretName).catch(() => null));
		if (shown === null) return;
		await navigator.clipboard.writeText(shown);
		addNotification({ type: 'success', title: 'Copied', message: secretName });
	}

	onMount(() => {
		void assistantStore.loadSecrets();
	});

	function reset() {
		adding = false;
		name = value = description = '';
	}

	async function save() {
		saving = true;
		try {
			await assistantStore.saveSecret({ name, value, description: description || undefined });
			reset();
		} catch (error) {
			addNotification({ type: 'error', title: 'Could not save', message: error instanceof Error ? error.message : String(error) });
		} finally {
			saving = false;
		}
	}

	async function remove(secretName: string) {
		const confirmed = await showConfirm({ title: `Delete “${secretName}”?`, message: 'Clopen can no longer use it.', confirmText: 'Delete', type: 'warning' });
		if (confirmed) await assistantStore.deleteSecret(secretName);
	}

	const field = 'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/60';
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-start gap-3">
		<div class="flex-1">
			<h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Secrets</h3>
			<p class="text-sm text-slate-500 dark:text-slate-400">Encrypted. Clopen uses them by name.</p>
		</div>
		{#if !adding}
			<button type="button" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium border-none cursor-pointer" onclick={() => (adding = true)}>
				<Icon name="lucide:plus" class="w-4 h-4" /> Add
			</button>
		{/if}
	</div>

	{#if adding}
		<form class="grid gap-2 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/60" onsubmit={(event) => { event.preventDefault(); void save(); }}>
			<input class={field} bind:value={name} placeholder="Name, e.g. gmail-password" aria-label="Name" required />
			<input class={field} type="password" bind:value={value} placeholder="Value" aria-label="Value" autocomplete="off" required />
			<input class={field} bind:value={description} placeholder="What it is for (optional)" aria-label="Description" />
			<div class="flex justify-end gap-2">
				<button type="button" class="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-sm text-slate-600 dark:text-slate-300 bg-transparent cursor-pointer" onclick={reset}>Cancel</button>
				<button type="submit" disabled={saving || !name.trim() || !value} class="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50">Save</button>
			</div>
		</form>
	{/if}

	{#if !assistantStore.loaded.secrets}
		<div class="flex items-center gap-2 text-sm text-slate-500"><Icon name="lucide:loader" class="w-4 h-4 animate-spin" /> Loading…</div>
	{:else if assistantStore.secrets.length === 0 && !adding}
		<p class="py-8 text-center text-sm text-slate-500 dark:text-slate-400">No secrets yet.</p>
	{:else}
		<ul class="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/60">
			{#each assistantStore.secrets as secret (secret.id)}
				<li class="flex items-center gap-3 px-3.5 py-2.5">
					<Icon name="lucide:key-round" class="w-4 h-4 text-violet-500 shrink-0" />
					<div class="flex-1 min-w-0">
						<div class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate font-mono">{secret.name}</div>
						<div class="text-xs text-slate-500 dark:text-slate-400 truncate">
							{secret.description || (secret.created_by === 'assistant' ? 'Saved by Clopen' : 'Added by you')}{secret.last_used_at ? ` · used ${relativeTime(secret.last_used_at)}` : ''}
						</div>
						{#if revealed[secret.name] !== undefined}
							<div class="mt-1 text-xs font-mono text-slate-800 dark:text-slate-200 break-all select-all">{revealed[secret.name]}</div>
						{/if}
					</div>
					<button type="button" title={revealed[secret.name] !== undefined ? 'Hide' : 'Show'} aria-label={revealed[secret.name] !== undefined ? 'Hide' : 'Show'} class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-violet-500/10 bg-transparent border-none cursor-pointer" onclick={() => reveal(secret.name)}>
						<Icon name={revealed[secret.name] !== undefined ? 'lucide:eye-off' : 'lucide:eye'} class="w-4 h-4" />
					</button>
					<button type="button" title="Copy" aria-label="Copy" class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-violet-500/10 bg-transparent border-none cursor-pointer" onclick={() => copy(secret.name)}>
						<Icon name="lucide:copy" class="w-4 h-4" />
					</button>
					<button type="button" title="Replace" aria-label="Replace" class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-violet-500/10 bg-transparent border-none cursor-pointer" onclick={() => { adding = true; name = secret.name; description = secret.description; value = ''; }}>
						<Icon name="lucide:pencil" class="w-4 h-4" />
					</button>
					<button type="button" title="Delete" aria-label="Delete" class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-600 bg-transparent border-none cursor-pointer" onclick={() => remove(secret.name)}>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
