<!--
	SSH terminal — one `<PtyTerminal>` per tab, streamed from the SSH PtyKit
	client over the app WebSocket.

	Tabs stay mounted and are toggled by opacity rather than `display:none`, for
	the same reason the local terminal does it: xterm needs a real layout or it
	repaints garbled and resizes toward zero on switch.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { PtyTerminal } from '@myrialabs/ptykit/svelte';
	import type { ComponentProps } from 'svelte';
	import {
		sshPtyClient,
		registerSshSession,
		unregisterSshSession,
		getSshSession
	} from '$frontend/services/ssh/ssh-pty-client';
	import { sshClientStore } from '$frontend/stores/features/ssh-client.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	// The shared client is a dist PtyKitClient; <PtyTerminal> (shipped as source)
	// types its `client` prop against the source build. They are structurally the
	// same class, so bridge the identities here rather than in every usage.
	const sharedClient = sshPtyClient as unknown as ComponentProps<typeof PtyTerminal>['client'];

	const view = $derived(sshClientStore.getView(connectionId));
	const tabs = $derived(view.tabs);
	const activeSessionId = $derived(view.activeSessionId);
	const namespace = $derived(`ssh:${connectionId}`);

	const fontSize = $derived(Math.round(settings.fontSize * 0.9));

	let showCloseAllConfirm = $state(false);
	let renaming = $state<{ sessionId: string; title: string } | null>(null);

	/** Live xterm instances per tab, kept only so Clear can wipe the client screen. */
	const terminals = new Map<string, { clear?: () => void }>();

	// Follow the app's dark/light class with PtyKit's matching built-in preset.
	function computeThemeName(): 'dark' | 'light' {
		const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
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

	/**
	 * Adopt whatever shells the host already has. This covers three cases with
	 * one call: tabs this browser opened before a refresh, tabs another viewer
	 * opened, and a first visit where there is nothing to adopt and we open one.
	 */
	$effect(() => {
		const id = connectionId;
		let cancelled = false;
		(async () => {
			try {
				const sessions = (await sshPtyClient.listSessions(`ssh:${id}`)) as
					| { sessions?: Array<{ sessionId: string }> }
					| Array<{ sessionId: string }>
					| null;
				if (cancelled) return;
				const list = Array.isArray(sessions) ? sessions : (sessions?.sessions ?? []);
				for (const session of list) sshClientStore.adoptTab(id, session.sessionId);
			} catch (error) {
				debug.warn('ssh', 'Could not list remote shells:', error);
			}
			if (cancelled) return;
			if (sshClientStore.getView(id).tabs.length === 0) {
				sshClientStore.openTab(id);
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	// Shells opened by another viewer appear as tabs here too, so a shared host
	// shows one tab list rather than diverging per browser.
	$effect(() => {
		const unsubscribe = sshPtyClient.onSessionCreated((event) => {
			if (event.namespace !== `ssh:${connectionId}`) return;
			sshClientStore.adoptTab(connectionId, event.sessionId);
		});
		return unsubscribe;
	});

	$effect(() => {
		const unsubscribe = sshPtyClient.onSessionClosed((event) => {
			sshClientStore.closeTab(connectionId, event.sessionId);
			unregisterSshSession(event.sessionId);
			terminals.delete(event.sessionId);
		});
		return unsubscribe;
	});

	function onTerminalReady(sessionId: string, context: { terminal: unknown; session: unknown }): void {
		registerSshSession(sessionId, context.session as Parameters<typeof registerSshSession>[1]);
		terminals.set(sessionId, context.terminal as { clear?: () => void });
	}

	async function closeTab(sessionId: string): Promise<void> {
		// Kill while the handle is still registered — unregistering first would
		// leave the remote shell running with nothing pointing at it.
		try {
			await getSshSession(sessionId)?.kill();
		} catch (error) {
			debug.warn('ssh', 'Could not kill remote shell:', error);
		}
		unregisterSshSession(sessionId);
		terminals.delete(sessionId);
		sshClientStore.closeTab(connectionId, sessionId);
		if (sshClientStore.getView(connectionId).tabs.length === 0) {
			sshClientStore.openTab(connectionId);
		}
	}

	async function closeAllTabs(): Promise<void> {
		showCloseAllConfirm = false;
		// Sequential: each close kills a shell and rewrites the tab list.
		for (const sessionId of tabs.map((tab) => tab.sessionId)) {
			await closeTab(sessionId);
		}
	}

	function clearActive(): void {
		if (!activeSessionId) return;
		terminals.get(activeSessionId)?.clear?.();
		void getSshSession(activeSessionId)?.clear();
	}

	function commitRename(value?: string): void {
		if (!renaming) return;
		const title = (value ?? renaming.title).trim();
		if (title) sshClientStore.renameTab(connectionId, renaming.sessionId, title);
		renaming = null;
	}
</script>

<div class="flex flex-col h-full min-h-0">
	<!-- Tab bar -->
	<div
		class="flex items-center shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-1.5 py-1 gap-1"
	>
		<div class="flex-1 flex items-center gap-0.5 overflow-x-auto no-scrollbar min-w-0">
			{#each tabs as tab (tab.sessionId)}
				{@const isActive = tab.sessionId === activeSessionId}
				<div
					class="flex items-center h-7 pl-2.5 pr-1 gap-1 rounded-md shrink-0 transition-colors {isActive
						? 'bg-violet-500/10'
						: 'hover:bg-slate-100 dark:hover:bg-slate-800'}"
				>
					<button
						type="button"
						class="flex items-center gap-1.5 h-full text-xs cursor-pointer {isActive
							? 'text-violet-700 dark:text-violet-300 font-semibold'
							: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}"
						onclick={() => sshClientStore.setActiveTab(connectionId, tab.sessionId)}
						ondblclick={() => (renaming = { sessionId: tab.sessionId, title: tab.title })}
					>
						<Icon name="lucide:terminal" class="w-3.5 h-3.5 shrink-0" />
						<span class="truncate max-w-[140px]">{tab.title}</span>
					</button>
					<button
						type="button"
						class="p-0.5 rounded opacity-60 hover:opacity-100 text-slate-400 hover:text-red-500 transition-all cursor-pointer shrink-0"
						onclick={() => closeTab(tab.sessionId)}
						title="Close shell"
						aria-label="Close shell"
					>
						<Icon name="lucide:x" class="w-3 h-3" />
					</button>
				</div>
			{/each}
		</div>

		<div class="flex items-center gap-0.5 shrink-0 pl-1">
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				onclick={() => sshClientStore.openTab(connectionId)}
				title="New shell"
				aria-label="New shell"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-40"
				onclick={clearActive}
				disabled={!activeSessionId}
				title="Clear screen"
				aria-label="Clear screen"
			>
				<Icon name="lucide:eraser" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-red-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-40"
				onclick={() => (showCloseAllConfirm = true)}
				disabled={tabs.length === 0}
				title="Close all shells"
				aria-label="Close all shells"
			>
				<Icon name="lucide:list-x" class="w-4 h-4" />
			</button>
		</div>
	</div>

	<div class="flex-1 relative min-h-0 overflow-hidden font-mono bg-slate-50 dark:bg-slate-950">
		{#each tabs as tab (tab.sessionId)}
			<div
				class="absolute inset-0"
				style:opacity={tab.sessionId === activeSessionId ? 1 : 0}
				style:z-index={tab.sessionId === activeSessionId ? 2 : 1}
				style:pointer-events={tab.sessionId === activeSessionId ? 'auto' : 'none'}
				aria-hidden={tab.sessionId !== activeSessionId}
			>
				<PtyTerminal
					client={sharedClient}
					{namespace}
					sessionId={tab.sessionId}
					create={true}
					showStatus={false}
					{fontSize}
					{theme}
					padding={12}
					onready={(context) => onTerminalReady(tab.sessionId, context)}
				/>
			</div>
		{/each}
	</div>
</div>

<Dialog
	bind:isOpen={showCloseAllConfirm}
	onClose={() => (showCloseAllConfirm = false)}
	type="warning"
	title="Close all shells"
	message="Close all {tabs.length} shells on this host? Anything still running in them is stopped."
	confirmText="Close shells"
	onConfirm={closeAllTabs}
/>

<Dialog
	isOpen={renaming !== null}
	onClose={() => (renaming = null)}
	title="Rename shell"
	inputValue={renaming?.title ?? ''}
	inputPlaceholder="Shell name"
	confirmText="Rename"
	onConfirm={commitRename}
/>
