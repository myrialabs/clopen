<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import {
		createWorktree,
		switchWorktreeContext,
		worktreeState
	} from '$frontend/stores/features/worktrees.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		/** Move the workspace into the new worktree once it exists. */
		switchOnCreate?: boolean;
	}

	let { isOpen = $bindable(false), onClose, switchOnCreate = true }: Props = $props();

	let name = $state('');
	let inputElement = $state<HTMLInputElement>();

	const projectName = $derived(projectState.currentProject?.name ?? '');
	const canSubmit = $derived(name.trim().length > 0 && !worktreeState.isCreating);

	function handleOpened() {
		name = '';
		inputElement?.focus();
	}

	function handleClose() {
		if (worktreeState.isCreating) return;
		isOpen = false;
		onClose();
	}

	async function submit() {
		if (!canSubmit) return;

		try {
			const worktree = await createWorktree(name.trim());
			isOpen = false;
			onClose();

			if (worktree) {
				addNotification({
					type: 'success',
					title: 'Worktree created',
					message: `"${worktree.name}" is ready — an isolated copy of ${projectName}.`,
					duration: 4000
				});
				if (switchOnCreate) await switchWorktreeContext(worktree.id);
			}
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Could not create worktree',
				message: error instanceof Error ? error.message : String(error),
				duration: 5000
			});
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void submit();
		}
	}
</script>

<Modal bind:isOpen onClose={handleClose} onOpened={handleOpened} title="New worktree" size="md">
	<div class="space-y-4">
		<p class="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
			A worktree is a private copy of <span class="font-medium text-slate-800 dark:text-slate-200">{projectName}</span>.
			Work done in it — by you or by the agent — never touches the main project until you apply it.
		</p>

		<div class="space-y-1.5">
			<label for="worktree-name" class="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
				Name
			</label>
			<input
				id="worktree-name"
				bind:this={inputElement}
				bind:value={name}
				onkeydown={handleKeydown}
				type="text"
				maxlength="80"
				placeholder="e.g. refactor auth"
				disabled={worktreeState.isCreating}
				class="w-full px-3 py-2 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/50 disabled:opacity-60"
			/>
		</div>

	</div>

	{#snippet footer()}
		<div class="flex justify-end gap-2">
			<Button variant="ghost" onclick={handleClose} disabled={worktreeState.isCreating}>Cancel</Button>
			<Button variant="primary" class="gap-2" onclick={submit} disabled={!canSubmit}>
				{#if worktreeState.isCreating}
					<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
					Creating…
				{:else}
					Create worktree
				{/if}
			</Button>
		</div>
	{/snippet}
</Modal>
