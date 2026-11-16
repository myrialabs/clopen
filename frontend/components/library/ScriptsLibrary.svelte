<script lang="ts">
	/**
	 * Scripts — automations that run without AI. Clopen saves them when it
	 * notices steps being repeated, or when asked; the owner can write and run
	 * their own here. A job can run any of them on a schedule at no token cost.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import type { Script, ScriptRunResult } from '$shared/types/assistant';

	let editing = $state<{ id?: string; name: string; description: string; runtime: 'bash' | 'bun'; content: string } | null>(null);
	let saving = $state(false);
	let running = $state<string | null>(null);
	let lastRun = $state<{ id: string; result: ScriptRunResult } | null>(null);

	onMount(() => {
		void assistantStore.loadScripts();
	});

	const SOURCE: Record<Script['source'], string> = {
		user: 'yours',
		assistant: 'by Clopen',
		detected: 'learned from repeated steps',
		recording: 'from a recording'
	};

	function projectName(id: string | null): string {
		return id ? projectState.projects.find((project) => project.id === id)?.name ?? 'a project' : 'all projects';
	}

	function startNew() {
		editing = { name: '', description: '', runtime: 'bash', content: '#!/usr/bin/env bash\nset -euo pipefail\n\n' };
	}

	async function save() {
		if (!editing) return;
		saving = true;
		try {
			await assistantStore.saveScript(editing);
			editing = null;
		} catch (error) {
			addNotification({ type: 'error', title: 'Could not save the script', message: error instanceof Error ? error.message : String(error) });
		} finally {
			saving = false;
		}
	}

	async function run(script: Script) {
		running = script.id;
		try {
			lastRun = { id: script.id, result: await assistantStore.runScript(script.id) };
		} catch (error) {
			addNotification({ type: 'error', title: 'Could not run the script', message: error instanceof Error ? error.message : String(error) });
		} finally {
			running = null;
		}
	}

	async function remove(script: Script) {
		if (await showConfirm({ title: `Delete "${script.name}"?`, message: 'Jobs that run it will fail until they use another script.', confirmText: 'Delete', type: 'warning' })) {
			await assistantStore.deleteScript(script.id);
		}
	}
</script>

<div class="space-y-4">
	<div class="flex items-start gap-3">
		<div class="flex-1">
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1">Scripts</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500">Automations that run without AI. Clopen saves steps it keeps repeating here, and jobs can run them on a schedule.</p>
		</div>
		<button type="button" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium border-none cursor-pointer shrink-0" onclick={startNew}><Icon name="lucide:plus" class="w-4 h-4" /> New</button>
	</div>

	{#if editing}
		<div class="rounded-xl border border-violet-500/30 bg-white dark:bg-slate-900 p-4 space-y-3">
			<div class="grid grid-cols-[1fr_auto] gap-2">
				<input class="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm outline-none focus:border-violet-500/60" placeholder="Name, e.g. restart-dev-server" bind:value={editing.name} aria-label="Name" />
				<select class="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm" bind:value={editing.runtime} aria-label="Runtime">
					<option value="bash">bash</option>
					<option value="bun">Bun (TypeScript, works on Windows)</option>
				</select>
			</div>
			<input class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm outline-none focus:border-violet-500/60" placeholder="What it does" bind:value={editing.description} aria-label="Description" />
			<textarea class="w-full min-h-48 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-mono outline-none focus:border-violet-500/60" bind:value={editing.content} aria-label="Script"></textarea>
			<div class="flex justify-end gap-2">
				<button type="button" class="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-sm bg-transparent cursor-pointer text-slate-600 dark:text-slate-300" onclick={() => (editing = null)}>Cancel</button>
				<button type="button" disabled={saving || !editing.name.trim() || !editing.content.trim()} class="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50" onclick={save}>{saving ? 'Saving…' : 'Save'}</button>
			</div>
		</div>
	{/if}

	{#if !assistantStore.loaded.scripts}
		<div class="flex items-center gap-2 text-sm text-slate-500"><Icon name="lucide:loader" class="w-4 h-4 animate-spin" /> Loading…</div>
	{:else if assistantStore.scripts.length === 0 && !editing}
		<p class="text-sm text-slate-500 dark:text-slate-400 py-6 text-center">No scripts yet. When an agent keeps running the same steps, Clopen will offer to save them here.</p>
	{:else}
		{#each assistantStore.scripts as script (script.id)}
			<div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-3.5">
				<div class="flex items-start gap-3">
					<Icon name="lucide:square-terminal" class="w-5 h-5 mt-0.5 text-violet-500 shrink-0" />
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{script.name}</span>
							<span class="px-1.5 py-0.5 rounded text-2xs bg-slate-100 dark:bg-slate-800 text-slate-500">{script.runtime}</span>
						</div>
						<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{script.description || '—'}</p>
						<p class="text-xs text-slate-400 mt-0.5">{SOURCE[script.source]} · {projectName(script.projectId)} · ran {script.runCount}×{script.lastExitCode !== null ? ` · last exit ${script.lastExitCode}` : ''}</p>
					</div>
					<div class="flex items-center gap-1 shrink-0">
						<button type="button" title="Run" aria-label="Run" disabled={running === script.id} class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-violet-500/10 bg-transparent border-none cursor-pointer disabled:opacity-50" onclick={() => run(script)}><Icon name={running === script.id ? 'lucide:loader' : 'lucide:play'} class="w-4 h-4 {running === script.id ? 'animate-spin' : ''}" /></button>
						<button type="button" title="Edit" aria-label="Edit" class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-violet-500/10 bg-transparent border-none cursor-pointer" onclick={() => (editing = { id: script.id, name: script.name, description: script.description, runtime: script.runtime, content: script.content })}><Icon name="lucide:pencil" class="w-4 h-4" /></button>
						<button type="button" title="Delete" aria-label="Delete" class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-600 bg-transparent border-none cursor-pointer" onclick={() => remove(script)}><Icon name="lucide:trash-2" class="w-4 h-4" /></button>
					</div>
				</div>
				{#if lastRun?.id === script.id}
					<pre class="mt-3 max-h-56 overflow-auto p-2.5 rounded-lg bg-slate-100 dark:bg-slate-950 text-2xs whitespace-pre-wrap">exit {lastRun.result.exitCode}{lastRun.result.timedOut ? ' (timed out)' : ''} · {(lastRun.result.durationMs / 1000).toFixed(1)}s
{lastRun.result.output || '(no output)'}</pre>
				{/if}
			</div>
		{/each}
	{/if}
</div>
