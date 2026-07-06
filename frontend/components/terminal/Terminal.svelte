<!--
	Terminal — renders one PtyKit <PtyTerminal/> per tab.

	Each tab mounts its own xterm streamed straight from the shared PtyKit client
	(riding the app WebSocket via hostSocket). Tabs stay mounted and are toggled by
	visibility so scrollback persists across switches; PtyKit replays serialized
	scrollback on (re)attach. Session handles are registered so the tab bar can
	close/clear/cancel a session directly.
-->
<script lang="ts">
	import { terminalStore } from '$frontend/stores/features/terminal.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { terminalService, terminalProjectManager } from '$frontend/services/terminal';
	import { ptyClient, registerSession, unregisterSession } from '$frontend/services/terminal/ptykit-client';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import TerminalTabs from './TerminalTabs.svelte';
	import { PtyTerminal } from '@myrialabs/ptykit/svelte';
	import type { ComponentProps } from 'svelte';

	// The shared client is a dist PtyKitClient; <PtyTerminal> (shipped as source)
	// types its `client` prop against the source build. They are structurally the
	// same class, so bridge the identities here rather than in every usage.
	const sharedClient = ptyClient as unknown as ComponentProps<typeof PtyTerminal>['client'];

	// Project-aware state
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectPath = $derived(projectState.currentProject?.path || '');
	const projectId = $derived(projectState.currentProject?.id || '');

	const activeSessionId = $derived(terminalStore.activeSessionId);
	const sessions = $derived(terminalStore.sessions);

	let isCancelling = $state(false);

	// Live xterm instances per tab, kept only so handleClear can clear the client
	// screen directly. Theme/font size are applied reactively by <PtyTerminal>.
	const terminals = new Map<string, { clear?: () => void }>();

	const fontSize = $derived(Math.round(settings.fontSize * 0.9));

	// Follow the app's dark/light class with PtyKit's matching built-in preset.
	// <PtyTerminal> re-themes reactively when this value changes.
	function computeThemeName(): 'dark' | 'light' {
		const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
		return dark ? 'dark' : 'light';
	}
	let theme = $state<'dark' | 'light'>(computeThemeName());

	// Track dark/light changes and swap the preset.
	$effect(() => {
		if (typeof document === 'undefined') return;
		const observer = new MutationObserver(() => {
			theme = computeThemeName();
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
		return () => observer.disconnect();
	});

	// Initialize terminal tabs once a project is active (restore is owned by the
	// workspace coordinator; we only kick off the project manager + store here).
	let isInitialized = false;
	$effect(() => {
		if (hasActiveProject && !isInitialized) {
			(async () => {
				if (typeof window === 'undefined') return;
				try {
					const { backgroundTerminalService } = await import('$frontend/services/terminal/background');
					terminalProjectManager.initialize();
					await backgroundTerminalService.initialize();
					let attempts = 0;
					while (!backgroundTerminalService.isRestorationDone() && attempts < 20) {
						await new Promise((resolve) => setTimeout(resolve, 100));
						attempts++;
					}
					terminalStore.initialize(hasActiveProject, projectPath);
					isInitialized = true;
				} catch {
					terminalStore.initialize(hasActiveProject, projectPath);
					isInitialized = true;
				}
			})();
		}
	});

	function onTerminalReady(sessionId: string, ctx: { terminal: any; session: any }) {
		registerSession(sessionId, ctx.session);
		terminals.set(sessionId, ctx.terminal);
	}

	function handleClear() {
		if (!activeSessionId) return;
		terminals.get(activeSessionId)?.clear?.();
		terminalService.clearHeadlessTerminal(activeSessionId);
	}

	async function handleCancel() {
		if (!activeSessionId) return;
		isCancelling = true;
		try {
			await terminalService.cancelCommand(activeSessionId);
		} finally {
			isCancelling = false;
		}
	}

	async function handleCloseSession(sessionId: string) {
		const isLastSession = terminalStore.sessions.length <= 1;
		// Close (and kill the PTY) while the session handle is still registered.
		// Unregistering earlier would make killSession a no-op and leak the shell —
		// a reused tab id would then re-attach the still-running old process.
		const closed = await terminalStore.closeSession(sessionId);
		unregisterSession(sessionId);
		terminals.delete(sessionId);
		if (closed && isLastSession) {
			await handleNewSession();
		}
	}

	async function handleNewSession() {
		if (!hasActiveProject || !projectId || !projectPath) return;
		try {
			const newSessionId = terminalProjectManager.addTerminalToCurrentProject(projectId, projectPath);
			if (!newSessionId) {
				await terminalProjectManager.switchToProject(projectId, projectPath);
				const retry = terminalProjectManager.addTerminalToCurrentProject(projectId, projectPath);
				if (!retry) {
					terminalStore.createNewSession(projectPath, projectPath, projectId);
				}
			}
		} catch {
			terminalStore.createNewSession(projectPath, projectPath, projectId);
		}
	}

	function handleRenameSession(sessionId: string, name: string) {
		terminalProjectManager.renameSession(sessionId, name);
	}

	// Exposed for parent components (workspace toolbar).
	export const terminalActions = {
		handleClear,
		handleNewSession,
		handleCancel,
		getSessions: () => terminalStore.sessions,
		getActiveSession: () => terminalStore.activeSession,
		isExecuting: () => false,
		isCancelling: () => isCancelling
	};
</script>

<div
	class="h-full bg-slate-50 dark:bg-slate-950 flex flex-col overflow-hidden min-h-0"
	role="application"
	aria-label="Terminal application"
>
	<div class="flex-shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
		<TerminalTabs
			sessions={sessions}
			activeSessionId={activeSessionId}
			onSwitchSession={(sessionId) => terminalStore.switchToSession(sessionId)}
			onCloseSession={handleCloseSession}
			onNewSession={handleNewSession}
			onRenameSession={handleRenameSession}
		/>
	</div>

	{#if sessions.length > 0}
		<div class="flex-1 relative min-h-0 overflow-hidden font-mono">
			<!-- All tabs stay mounted and full-size; inactive ones are hidden via
			     opacity/z-index (never display:none) so xterm keeps a valid layout
			     and never repaints garbled or resizes toward zero on switch. -->
			{#each sessions as session (session.id)}
				<div
					class="absolute inset-0"
					style:opacity={session.id === activeSessionId ? 1 : 0}
					style:z-index={session.id === activeSessionId ? 2 : 1}
					style:pointer-events={session.id === activeSessionId ? 'auto' : 'none'}
					aria-hidden={session.id !== activeSessionId}
				>
					{#if session.projectId}
						<!-- Appearance (theme presets, scrollback, cursor, addons, right-
						     click copy-paste, loading spinner, height-fill + scrollbar
						     chrome) comes from PtyKit. Clopen only picks the dark/light
						     preset and passes font, cwd, and wiring. -->
						<PtyTerminal
							client={sharedClient}
							namespace={session.projectId}
							sessionId={session.id}
							create={true}
							cwd={session.projectPath || session.directory}
							showStatus={false}
							fontSize={fontSize}
							theme={theme}
							padding={12}
							onready={(ctx) => onTerminalReady(session.id, ctx)}
						/>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="flex-1 flex items-center justify-center font-mono">
			<div class="text-center text-slate-600 dark:text-slate-400">
				<p>No terminal sessions available</p>
			</div>
		</div>
	{/if}
</div>
