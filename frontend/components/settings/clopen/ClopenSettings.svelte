<script lang="ts">
	/**
	 * How Clopen works — the choices that decide how much the assistant does on
	 * its own, what it may never do without asking, where the app opens, and
	 * whether Clopen starts with the computer so jobs keep their schedule.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import type { AssistantAutonomy } from '$shared/types/assistant';

	let autostartBusy = $state(false);

	onMount(() => {
		void assistantStore.loadSettings();
		void assistantStore.loadAutostart();
	});

	const settings = $derived(assistantStore.settings);
	const autostart = $derived(assistantStore.autostart);

	async function setAutonomy(autonomy: AssistantAutonomy) {
		await assistantStore.saveSettings({ autonomy });
	}

	async function toggleAutostart() {
		if (!autostart) return;
		autostartBusy = true;
		try {
			const status = await assistantStore.setAutostart(!autostart.enabled);
			addNotification({
				type: 'success',
				title: status.enabled ? 'Clopen will start with this computer' : 'Clopen will no longer start with this computer',
				message: status.enabled ? 'From your next log in, jobs keep their schedule even after a restart.' : 'Start it yourself with the clopen command.'
			});
		} catch (error) {
			addNotification({ type: 'error', title: 'Could not change that', message: error instanceof Error ? error.message : String(error) });
		} finally {
			autostartBusy = false;
		}
	}

	const card = 'w-full text-left p-4 rounded-xl border-2 transition-all cursor-pointer';
</script>

<div class="space-y-6">
	<div>
		<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Clopen</h3>
		<p class="text-sm text-slate-600 dark:text-slate-500">
			The assistant you talk to. It hands work to agents and reports back.
		</p>
	</div>

	{#if !settings}
		<div class="flex items-center gap-2 text-sm text-slate-500"><Icon name="lucide:loader" class="w-4 h-4 animate-spin" /> Loading…</div>
	{:else}
		<section class="space-y-2.5">
			<h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">How much Clopen does on its own</h4>
			<button type="button" class="{card} {settings.autonomy === 'autonomous' ? 'border-violet-500 bg-violet-50/50 dark:bg-violet-900/10' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}" onclick={() => setAutonomy('autonomous')}>
				<div class="flex items-start gap-3">
					<Icon name="lucide:rocket" class="w-5 h-5 mt-0.5 text-violet-500 shrink-0" />
					<div class="flex-1">
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Autonomous</div>
						<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Works until it is done; asks only what only you can decide.</div>
					</div>
					{#if settings.autonomy === 'autonomous'}<Icon name="lucide:circle-check" class="w-5 h-5 text-violet-500 shrink-0" />{/if}
				</div>
			</button>
			<button type="button" class="{card} {settings.autonomy === 'ask' ? 'border-violet-500 bg-violet-50/50 dark:bg-violet-900/10' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}" onclick={() => setAutonomy('ask')}>
				<div class="flex items-start gap-3">
					<Icon name="lucide:messages-square" class="w-5 h-5 mt-0.5 text-slate-500 shrink-0" />
					<div class="flex-1">
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Discuss first</div>
						<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Shows a plan first and starts after your OK.</div>
					</div>
					{#if settings.autonomy === 'ask'}<Icon name="lucide:circle-check" class="w-5 h-5 text-violet-500 shrink-0" />{/if}
				</div>
			</button>
		</section>

		<section class="space-y-2.5">
			<h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Things that cannot be undone</h4>
			<label class="flex items-start gap-3 p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 cursor-pointer">
				<input type="checkbox" class="mt-1 w-4 h-4 accent-violet-600" checked={!settings.allowIrreversible} onchange={(event) => assistantStore.saveSettings({ allowIrreversible: !(event.currentTarget as HTMLInputElement).checked })} />
				<div>
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Ask me before anything irreversible</div>
					<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
						Deleting, force-pushing, publishing or deploying wait for your OK.
					</div>
				</div>
			</label>
		</section>

		<section class="space-y-2.5">
			<h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Starting up</h4>
			<div class="p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 space-y-3">
				<div class="flex items-center justify-between gap-3">
					<div>
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Open with</div>
						<div class="text-xs text-slate-500 dark:text-slate-400">What you see when Clopen opens.</div>
					</div>
					<select class="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm" value={settings.startView} onchange={(event) => assistantStore.saveSettings({ startView: (event.currentTarget as HTMLSelectElement).value as 'assistant' | 'workspace' })}>
						<option value="assistant">Clopen (the assistant)</option>
						<option value="workspace">My last project</option>
					</select>
				</div>
				<div class="flex items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-700/50">
					<div>
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Start Clopen with this computer</div>
						<div class="text-xs text-slate-500 dark:text-slate-400">
							{#if !autostart}Checking…{:else if !autostart.supported}{autostart.reason}{:else}Jobs only run while Clopen is running. With this on, they keep their schedule after a restart. Uses your own account's startup — no admin rights.{/if}
						</div>
					</div>
					<button
						type="button"
						disabled={!autostart?.supported || autostartBusy}
						class="relative w-12 h-6.5 shrink-0 rounded-3xl border-none cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed {autostart?.enabled ? 'bg-gradient-to-br from-violet-600 to-purple-600' : 'bg-slate-600/40'}"
						onclick={toggleAutostart}
						aria-pressed={autostart?.enabled ?? false}
						aria-label="Start Clopen with this computer"
					>
						<span class="absolute top-0.75 left-0.75 w-5 h-5 rounded-full bg-white transition-transform {autostart?.enabled ? 'translate-x-5.5' : ''}"></span>
					</button>
				</div>
			</div>
		</section>

		<section class="space-y-2.5">
			<h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">More</h4>
			<div class="grid sm:grid-cols-2 gap-2">
				<button type="button" class="flex items-center gap-2.5 p-3 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 text-left cursor-pointer hover:border-violet-500/40" onclick={() => openSettingsModal('models')}>
					<Icon name="lucide:bot" class="w-4 h-4 text-violet-500" /><span class="text-sm text-slate-700 dark:text-slate-300">Which model Clopen uses</span>
				</button>
				<button type="button" class="flex items-center gap-2.5 p-3 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 text-left cursor-pointer hover:border-violet-500/40" onclick={() => openSettingsModal('notifications')}>
					<Icon name="lucide:bell" class="w-4 h-4 text-violet-500" /><span class="text-sm text-slate-700 dark:text-slate-300">How Clopen reaches you</span>
				</button>
			</div>
		</section>
	{/if}
</div>
