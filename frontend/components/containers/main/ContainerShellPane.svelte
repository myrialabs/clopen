<!--
	Containers — a shell inside one container.

	The same `<PtyTerminal>` the local and SSH terminals use, on its own PtyKit
	client. The session id is derived from the container rather than generated,
	so going back to the list and returning reattaches to the shell that is
	already running instead of leaving it orphaned and starting a second.

	The namespace carries the host and the container, and it is the only thing
	the client gets to say about what it wants: the server checks it, derives the
	spawn target from it, and refuses anything a non-admin asks for.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { PtyTerminal } from '@myrialabs/ptykit/svelte';
	import type { ComponentProps } from 'svelte';
	import {
		containerNamespace,
		containerPtyClient,
		containerSessionId
	} from '$frontend/services/containers/container-pty-client';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import type { ContainerEntry } from '$shared/types/containers';

	interface Props {
		hostId: string;
		entry: ContainerEntry;
		/** Back to the lists, leaving the shell running. */
		onBack: () => void;
		/** Close the shell for good, killing the session. */
		onClose: () => void;
	}

	const { hostId, entry, onBack, onClose }: Props = $props();

	// The shared client is a dist PtyKitClient; <PtyTerminal> (shipped as source)
	// types its `client` prop against the source build. They are structurally the
	// same class, so bridge the identities here rather than in every usage.
	const sharedClient = containerPtyClient as unknown as ComponentProps<
		typeof PtyTerminal
	>['client'];

	const namespace = $derived(containerNamespace(hostId, entry.id));
	const sessionId = $derived(containerSessionId(hostId, entry.id));
	const fontSize = $derived(Math.round(settings.fontSize * 0.9));

	let session = $state<{ kill(): Promise<void> } | null>(null);

	// Follow the app's dark/light class with PtyKit's matching built-in preset.
	function computeThemeName(): 'dark' | 'light' {
		const isDark =
			typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
		return isDark ? 'dark' : 'light';
	}
	let theme = $state<'dark' | 'light'>(computeThemeName());

	$effect(() => {
		if (typeof document === 'undefined') return;
		const observer = new MutationObserver(() => {
			theme = computeThemeName();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'data-theme']
		});
		return () => observer.disconnect();
	});

	async function endSession(): Promise<void> {
		try {
			await session?.kill();
		} catch {
			// Already gone — closing the view is still the right outcome.
		}
		onClose();
	}
</script>

<div class="flex flex-col flex-1 min-h-0">
	<header
		class="flex items-center gap-2 px-2.5 sm:px-3 py-2 shrink-0 border-b border-slate-200 dark:border-slate-800"
	>
		<button
			type="button"
			class="flex items-center gap-1.5 shrink-0 px-2 h-8 rounded-lg bg-transparent border-none text-slate-500 dark:text-slate-400 text-xs cursor-pointer hover:bg-violet-500/10"
			onclick={onBack}
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			<span class="hidden sm:inline">Back</span>
		</button>

		<div class="flex flex-col min-w-0 flex-1">
			<span class="truncate text-sm font-semibold text-slate-800 dark:text-slate-200">
				{entry.name}
			</span>
			<span class="truncate text-[11px] text-slate-400 dark:text-slate-600">
				a shell inside the container · {entry.image}
			</span>
		</div>

		<button
			type="button"
			class="flex items-center gap-1.5 shrink-0 px-2 h-8 rounded-lg bg-transparent border-none text-slate-400 text-xs cursor-pointer hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
			onclick={endSession}
			title="End this shell"
		>
			<Icon name="lucide:x" class="w-4 h-4" />
			<span class="hidden sm:inline">End shell</span>
		</button>
	</header>

	<div class="flex-1 relative min-h-0 overflow-hidden font-mono bg-slate-50 dark:bg-slate-950">
		{#key sessionId}
			<PtyTerminal
				client={sharedClient}
				{namespace}
				{sessionId}
				create={true}
				showStatus={false}
				{fontSize}
				{theme}
				padding={12}
				onready={(context) => (session = context.session as { kill(): Promise<void> })}
			/>
		{/key}
	</div>
</div>
