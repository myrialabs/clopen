<script lang="ts">
	/**
	 * Teach a task — record what you do in the preview once, and Clopen can
	 * repeat it. While recording, every page you open, click and keystroke in
	 * this project's preview is a step; stopping offers to save the steps as a
	 * skill (an agent replays them, adapting when the page changed) or a
	 * script (replays the page loads, no AI).
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ws from '$frontend/utils/ws';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { TaskRecording } from '$shared/types/assistant';

	let recording = $state(false);
	let busy = $state(false);
	let stopped = $state<TaskRecording | null>(null);
	let name = $state('');
	let purpose = $state('');
	let saveAs = $state<'skill' | 'script'>('skill');

	const projectId = $derived(projectState.currentProject?.id ?? null);

	$effect(() => {
		const id = projectId;
		if (!id) return;
		void ws.http('assistant:recording-state', { projectId: id }).then((state) => (recording = state.recording)).catch(() => (recording = false));
		return ws.on('assistant:changed', (data: { scope: string }) => {
			if (data.scope !== 'recordings') return;
			void ws.http('assistant:recording-state', { projectId: id }).then((state) => (recording = state.recording)).catch(() => undefined);
		});
	});

	async function toggle() {
		if (!projectId) return;
		busy = true;
		try {
			if (!recording) {
				await ws.http('assistant:recording-start', { projectId });
				recording = true;
				addNotification({ type: 'info', title: 'Recording', message: 'Do the task in the preview. Click the record button again when you are done.' });
			} else {
				const result = (await ws.http('assistant:recording-stop', { projectId })) as TaskRecording | null;
				recording = false;
				if (result && result.steps.length > 0) {
					stopped = result;
					name = '';
					purpose = '';
				} else {
					addNotification({ type: 'warning', title: 'Nothing recorded', message: 'No steps were captured.' });
				}
			}
		} catch (error) {
			addNotification({ type: 'error', title: 'Recording failed', message: error instanceof Error ? error.message : String(error) });
		} finally {
			busy = false;
		}
	}

	async function save() {
		if (!stopped || !name.trim()) return;
		busy = true;
		try {
			const result = await ws.http('assistant:recording-save', { id: stopped.id, name: name.trim(), as: saveAs, purpose });
			addNotification({ type: 'success', title: saveAs === 'skill' ? 'Saved as a skill' : 'Saved as a script', message: saveAs === 'skill' ? `Run it with /${result.ref}, or ask Clopen to.` : `Run ${result.ref} from Library → Scripts or a job.` });
			stopped = null;
		} catch (error) {
			addNotification({ type: 'error', title: 'Could not save', message: error instanceof Error ? error.message : String(error) });
		} finally {
			busy = false;
		}
	}

	async function discard() {
		if (stopped) await ws.http('assistant:recording-delete', { id: stopped.id }).catch(() => undefined);
		stopped = null;
	}
</script>

{#if projectId}
	<button
		type="button"
		onclick={toggle}
		disabled={busy}
		class="relative flex items-center justify-center rounded-md transition-colors h-7 w-7 disabled:opacity-50 {recording
			? 'bg-red-500/10 text-red-600 dark:text-red-400'
			: 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100'}"
		title={recording ? 'Stop recording this task' : 'Teach a task: record what you do here so Clopen can repeat it'}
		aria-label={recording ? 'Stop recording' : 'Record a task'}
		aria-pressed={recording}
	>
		<Icon name={recording ? 'lucide:circle-stop' : 'lucide:circle-dot'} class="h-4 w-4 {recording ? 'animate-pulse' : ''}" />
	</button>
{/if}

<Modal isOpen={stopped !== null} onClose={discard} size="md" title="Save what you recorded">
	{#snippet children()}
		{#if stopped}
			<div class="space-y-3">
				<p class="text-sm text-slate-600 dark:text-slate-400">{stopped.steps.length} step{stopped.steps.length === 1 ? '' : 's'} recorded.</p>
				<input class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm" placeholder="Name, e.g. check-out a test order" bind:value={name} aria-label="Name" />
				<textarea class="w-full min-h-20 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm" placeholder="What is this task for? (helps the agent adapt when the page changes)" bind:value={purpose} aria-label="Purpose"></textarea>
				<div class="grid grid-cols-2 gap-2">
					<button type="button" class="p-3 rounded-lg border-2 text-left cursor-pointer {saveAs === 'skill' ? 'border-violet-500 bg-violet-500/5' : 'border-slate-200 dark:border-slate-700'}" onclick={() => (saveAs = 'skill')}>
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Skill</div>
						<div class="text-xs text-slate-500">An agent repeats it, adapting if the page changed.</div>
					</button>
					<button type="button" class="p-3 rounded-lg border-2 text-left cursor-pointer {saveAs === 'script' ? 'border-violet-500 bg-violet-500/5' : 'border-slate-200 dark:border-slate-700'}" onclick={() => (saveAs = 'script')}>
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Script</div>
						<div class="text-xs text-slate-500">Replays the pages it opened. No AI, no tokens.</div>
					</button>
				</div>
				<div class="max-h-40 overflow-y-auto text-xs text-slate-500 space-y-0.5 font-mono">
					{#each stopped.steps.slice(0, 50) as step, index (index)}
						<div>{index + 1}. {step.type === 'navigate' ? `open ${step.url}` : step.type === 'click' ? `click ${step.target ?? `${step.x},${step.y}`}` : step.type === 'type' ? `type "${step.text}"` : step.type === 'key' ? `press ${step.key}` : `scroll ${step.deltaY}`}</div>
					{/each}
				</div>
				<div class="flex justify-end gap-2">
					<button type="button" class="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-sm bg-transparent cursor-pointer text-slate-600 dark:text-slate-300" onclick={discard}>Discard</button>
					<button type="button" disabled={busy || !name.trim()} class="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50" onclick={save}>Save</button>
				</div>
			</div>
		{/if}
	{/snippet}
</Modal>
