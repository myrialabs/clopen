<!--
	Port forwarding for one host: local (-L), remote (-R) and dynamic (-D).
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { sshClientStore } from '$frontend/stores/features/ssh-client.svelte';
	import type { SshForward, SshForwardInput, SshForwardType } from '$shared/types/ssh';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	const TYPE_LABELS: Record<SshForwardType, string> = {
		local: 'Local (-L)',
		remote: 'Remote (-R)',
		dynamic: 'Dynamic SOCKS5 (-D)'
	};

	const TYPE_HINTS: Record<SshForwardType, string> = {
		local: 'Listen on this machine and forward each connection to the destination, reached from the remote host.',
		remote: 'Ask the remote host to listen, and forward what arrives there to the destination, reached from this machine.',
		dynamic: 'Listen on this machine as a SOCKS5 proxy. Applications pointed at it reach anything the remote host can.'
	};

	const forwards = $derived(sshClientStore.forwards[connectionId] ?? []);
	const statuses = $derived(sshClientStore.forwardStatuses[connectionId] ?? {});

	let loading = $state(false);
	let panelError = $state<string | null>(null);
	let busyId = $state<string | null>(null);
	let deleteTarget = $state<SshForward | null>(null);

	let editing = $state<SshForward | null>(null);
	let formOpen = $state(false);
	let formName = $state('');
	let formType = $state<SshForwardType>('local');
	let formListenHost = $state('127.0.0.1');
	let formListenPort = $state<number>(0);
	let formDestHost = $state('127.0.0.1');
	let formDestPort = $state<number>(0);
	let formAutoStart = $state(false);
	let formError = $state<string | null>(null);

	$effect(() => {
		const id = connectionId;
		loading = true;
		sshClientStore
			.loadForwards(id)
			.catch((error) => {
				panelError = error instanceof Error ? error.message : 'Could not load forwards';
			})
			.finally(() => {
				loading = false;
			});
	});

	function startCreate(): void {
		editing = null;
		formName = '';
		formType = 'local';
		formListenHost = '127.0.0.1';
		formListenPort = 0;
		formDestHost = '127.0.0.1';
		formDestPort = 0;
		formAutoStart = false;
		formError = null;
		formOpen = true;
	}

	function startEdit(forward: SshForward): void {
		editing = forward;
		formName = forward.name;
		formType = forward.type;
		formListenHost = forward.listenHost;
		formListenPort = forward.listenPort;
		formDestHost = forward.destHost ?? '127.0.0.1';
		formDestPort = forward.destPort ?? 0;
		formAutoStart = forward.autoStart;
		formError = null;
		formOpen = true;
	}

	function buildInput(): SshForwardInput {
		return {
			name: formName.trim(),
			type: formType,
			listenHost: formListenHost.trim() || '127.0.0.1',
			listenPort: formListenPort,
			destHost: formType === 'dynamic' ? undefined : formDestHost.trim(),
			destPort: formType === 'dynamic' ? undefined : formDestPort,
			autoStart: formAutoStart
		};
	}

	function validate(): string | null {
		if (!formName.trim()) return 'Name is required';
		if (!Number.isInteger(formListenPort) || formListenPort < 0 || formListenPort > 65535) {
			return 'Listen port must be between 0 and 65535';
		}
		if (formType !== 'dynamic') {
			if (!formDestHost.trim()) return 'Destination host is required';
			if (!formDestPort) return 'Destination port is required';
		}
		return null;
	}

	async function save(): Promise<void> {
		const error = validate();
		if (error) {
			formError = error;
			return;
		}
		formError = null;
		try {
			if (editing) {
				await sshClientStore.updateForward(connectionId, editing.id, buildInput());
			} else {
				await sshClientStore.createForward(connectionId, buildInput());
			}
			formOpen = false;
		} catch (saveError) {
			formError = saveError instanceof Error ? saveError.message : 'Save failed';
		}
	}

	async function toggle(forward: SshForward): Promise<void> {
		busyId = forward.id;
		panelError = null;
		try {
			if (statuses[forward.id]?.running) {
				await sshClientStore.stopForward(connectionId, forward.id);
			} else {
				await sshClientStore.startForward(connectionId, forward.id);
			}
		} catch (error) {
			panelError = error instanceof Error ? error.message : 'Could not change that forward';
		} finally {
			busyId = null;
		}
	}

	async function commitDelete(): Promise<void> {
		const target = deleteTarget;
		deleteTarget = null;
		if (!target) return;
		try {
			await sshClientStore.deleteForward(connectionId, target.id);
		} catch (error) {
			panelError = error instanceof Error ? error.message : 'Could not delete that forward';
		}
	}

	function describe(forward: SshForward): string {
		const status = statuses[forward.id];
		const listen = `${forward.listenHost}:${status?.boundPort ?? forward.listenPort}`;
		if (forward.type === 'dynamic') return `${listen} → SOCKS5 via host`;
		const destination = `${forward.destHost}:${forward.destPort}`;
		return forward.type === 'local' ? `${listen} → ${destination}` : `remote ${listen} → ${destination}`;
	}

	const fieldClass =
		'px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-900 dark:text-slate-100';
</script>

<!-- @container: measured against this pane, not the viewport. -->
<div class="@container flex flex-col h-full min-h-0">
	<div
		class="flex items-center justify-between gap-2 shrink-0 px-3 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800"
	>
		<span class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
			Port Forwarding
		</span>
		<button
			type="button"
			class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-violet-700 dark:text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 transition-colors"
			onclick={startCreate}
		>
			<Icon name="lucide:plus" class="w-3.5 h-3.5" />
			New forward
		</button>
	</div>

	{#if panelError}
		<div
			class="shrink-0 px-3 py-2 text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 whitespace-pre-wrap wrap-anywhere"
		>
			{panelError}
		</div>
	{/if}

	<div class="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
		{#if loading && forwards.length === 0}
			<div class="flex items-center justify-center py-10 text-xs text-slate-500">Loading…</div>
		{:else if forwards.length === 0}
			<div class="flex flex-col items-center gap-2 py-10 text-center text-slate-500">
				<Icon name="lucide:arrow-left-right" class="w-8 h-8 opacity-40" />
				<span class="text-xs">No port forwards on this host</span>
				<button
					type="button"
					class="text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 underline"
					onclick={startCreate}
				>
					Add one
				</button>
			</div>
		{:else}
			{#each forwards as forward (forward.id)}
				{@const status = statuses[forward.id]}
				<!-- Stacked below sm: the name, its address pair and three controls do
				     not fit on one line at phone width. -->
				<div
					class="flex flex-col @2xl:flex-row @2xl:items-center gap-2 @2xl:gap-3 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
				>
					<div class="flex items-start gap-3 flex-1 min-w-0">
						<span
							class="w-2 h-2 mt-1.5 rounded-full shrink-0 {status?.running
								? 'bg-emerald-500'
								: 'bg-slate-300 dark:bg-slate-600'}"
						></span>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 min-w-0">
								<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
									{forward.name}
								</span>
								<span
									class="text-3xs uppercase tracking-wider text-slate-500 dark:text-slate-400 shrink-0"
								>
									{forward.type}
								</span>
								{#if forward.autoStart}
									<span
										class="text-3xs uppercase tracking-wider text-violet-600 dark:text-violet-400 shrink-0"
									>
										auto
									</span>
								{/if}
							</div>
							<div class="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate">
								{describe(forward)}
							</div>
							{#if status?.error}
								<div class="text-[11px] text-red-600 dark:text-red-400 wrap-anywhere">
									{status.error}
								</div>
							{:else if status?.running && status.connectionCount > 0}
								<div class="text-[11px] text-slate-400">
									{status.connectionCount} connection{status.connectionCount === 1 ? '' : 's'}
								</div>
							{/if}
						</div>
					</div>
					<div class="flex items-center gap-0.5 shrink-0 self-end @2xl:self-auto">
						<button
							type="button"
							class="px-2.5 py-1 rounded-md text-xs transition-colors disabled:opacity-50 {status?.running
								? 'text-red-600 dark:text-red-400 hover:bg-red-500/10'
								: 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10'}"
							onclick={() => toggle(forward)}
							disabled={busyId === forward.id}
						>
							{busyId === forward.id ? '…' : status?.running ? 'Stop' : 'Start'}
						</button>
						<button
							type="button"
							class="p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-500/10"
							onclick={() => startEdit(forward)}
							title="Edit"
							aria-label="Edit"
						>
							<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							class="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-500/10"
							onclick={() => (deleteTarget = forward)}
							title="Delete"
							aria-label="Delete"
						>
							<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
						</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>

<!--
	A Modal rather than a Dialog: Dialog closes itself on confirm, which would
	dismiss the form before a validation or save error could be read.
-->
<Modal
	bind:isOpen={formOpen}
	onClose={() => (formOpen = false)}
	bare
	mobileFullscreen
	ariaLabelledBy="ssh-forward-form-title"
	className="flex flex-col w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden"
>
	{#snippet children()}
		<header
			class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0"
		>
			<h2
				id="ssh-forward-form-title"
				class="text-sm font-semibold text-slate-900 dark:text-slate-100 m-0"
			>
				{editing ? 'Edit forward' : 'New forward'}
			</h2>
			<button
				type="button"
				class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-violet-500/10"
				onclick={() => (formOpen = false)}
				aria-label="Close"
			>
				<Icon name="lucide:x" class="w-5 h-5" />
			</button>
		</header>

		<div class="flex flex-col gap-3 p-4 overflow-y-auto">
			<label class="flex flex-col gap-1">
				<span class="text-xs text-slate-500 dark:text-slate-400">Name</span>
				<input type="text" bind:value={formName} class={fieldClass} placeholder="Database tunnel" />
			</label>

			<label class="flex flex-col gap-1">
				<span class="text-xs text-slate-500 dark:text-slate-400">Type</span>
				<select bind:value={formType} class={fieldClass}>
					{#each Object.entries(TYPE_LABELS) as [value, label] (value)}
						<option {value}>{label}</option>
					{/each}
				</select>
				<span class="text-xs text-slate-500 dark:text-slate-500">{TYPE_HINTS[formType]}</span>
			</label>

			<div class="grid grid-cols-3 gap-2">
				<label class="col-span-2 flex flex-col gap-1">
					<span class="text-xs text-slate-500 dark:text-slate-400">
						{formType === 'remote' ? 'Remote listen host' : 'Listen host'}
					</span>
					<input type="text" bind:value={formListenHost} class={fieldClass} />
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs text-slate-500 dark:text-slate-400">
						Port <span class="text-slate-400">(0 = auto)</span>
					</span>
					<input type="number" bind:value={formListenPort} class={fieldClass} />
				</label>
			</div>

			{#if formType !== 'dynamic'}
				<div class="grid grid-cols-3 gap-2">
					<label class="col-span-2 flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">Destination host</span>
						<input type="text" bind:value={formDestHost} class={fieldClass} />
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs text-slate-500 dark:text-slate-400">Port</span>
						<input type="number" bind:value={formDestPort} class={fieldClass} />
					</label>
				</div>
			{/if}

			<button
				type="button"
				class="flex items-center justify-between w-full text-sm text-slate-700 dark:text-slate-300 cursor-pointer"
				onclick={() => (formAutoStart = !formAutoStart)}
			>
				<span class="flex items-center gap-2">
					<Icon name="lucide:play" class="w-4 h-4" />
					Start automatically
				</span>
				<span
					class="text-xs px-2 py-0.5 rounded-full {formAutoStart
						? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300'
						: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}"
				>
					{formAutoStart ? 'On' : 'Off'}
				</span>
			</button>
			<span class="text-xs text-slate-500 dark:text-slate-500 -mt-2">
				Auto-start forwards come up whenever you open this host.
			</span>

			{#if editing}
				<span class="text-xs text-slate-500 dark:text-slate-500">
					Saving stops this forward — a listener cannot change while it is bound. Start it again
					when you are done.
				</span>
			{/if}

			{#if formError}
				<div
					class="px-3 py-2 rounded-md text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
				>
					{formError}
				</div>
			{/if}
		</div>

		<footer
			class="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0"
		>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
				onclick={() => (formOpen = false)}
			>
				Cancel
			</button>
			<button
				type="button"
				class="px-3 py-1.5 text-sm rounded-md bg-violet-600 hover:bg-violet-700 text-white"
				onclick={save}
			>
				{editing ? 'Save' : 'Create'}
			</button>
		</footer>
	{/snippet}
</Modal>

<Dialog
	isOpen={deleteTarget !== null}
	onClose={() => (deleteTarget = null)}
	type="warning"
	title="Delete forward"
	message="Delete “{deleteTarget?.name ?? ''}”? If it is running it is stopped first."
	confirmText="Delete"
	onConfirm={commitDelete}
/>
