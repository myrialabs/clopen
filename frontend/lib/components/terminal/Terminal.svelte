<!--
	Pure XTerminal Integration - Clean Terminal Component
	All terminal functionality handled by xterm.js
-->
<script lang="ts">
	import { terminalStore } from '$frontend/lib/stores/features/terminal.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import { getShortcutLabels } from '$frontend/lib/utils/platform';
	import TerminalTabs from './TerminalTabs.svelte';
	import LoadingSpinner from '../common/LoadingSpinner.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import XTerm from '$frontend/lib/components/common/xterm/XTerm.svelte';

	// Project-aware state
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectPath = $derived(projectState.currentProject?.path || '');
	const projectId = $derived(projectState.currentProject?.id || '');

	// Terminal state from store
	const activeSession = $derived(terminalStore.activeSession);
	// Use session-specific execution state instead of global
	const isExecuting = $derived(activeSession ? terminalStore.isSessionExecuting(activeSession.id) : false);

	// XTerminal reference and cancellation state
	let xterminalRef = $state<{ scrollToBottom: () => void; clear: () => void; writeData: (data: string) => void }>();
	let isCancelling = $state(false);
	let terminalContainer: HTMLDivElement | undefined = $state();

	// Get platform-specific shortcut labels
	const shortcuts = $derived(getShortcutLabels());

	// Initialize terminal only once when component mounts
	let isInitialized = false;
	$effect(() => {
		if (hasActiveProject && !isInitialized) {
			// Wait for background service to complete restoration
			const checkAndInitialize = async () => {
				if (typeof window !== 'undefined') {
					try {
						const { backgroundTerminalService } = await import('$frontend/lib/services/terminal/background');
						const { terminalProjectManager } = await import('$frontend/lib/services/terminal');

						// Initialize terminalProjectManager first
						terminalProjectManager.initialize();

						// First ensure background service is initialized
						await backgroundTerminalService.initialize();

						// Wait for restoration to complete (max 2 seconds)
						let attempts = 0;
						while (!backgroundTerminalService.isRestorationDone() && attempts < 20) {
							await new Promise(resolve => setTimeout(resolve, 100));
							attempts++;
						}

						// Now safe to initialize terminal store
						terminalStore.initialize(hasActiveProject, projectPath);

						// Ensure project context is set up in terminalProjectManager
						if (projectId && projectPath) {
							await terminalProjectManager.switchToProject(projectId, projectPath);
						}

						isInitialized = true;
					} catch (error) {
						// Failed to initialize terminal services
						// If background service fails, just initialize normally
						terminalStore.initialize(hasActiveProject, projectPath);
						isInitialized = true;
					}
				}
			};

			checkAndInitialize();
		}
	});

	// Setup event listeners for Ctrl+C handling
	$effect(() => {
		if (typeof window !== 'undefined') {
			// Use capture phase to intercept Ctrl+C before XTerm
			const handleGlobalKeyDown = (e: KeyboardEvent) => {
				// Check if terminal is focused
				const terminalElement = document.querySelector('.xterm');
				const isTerminalFocused = terminalElement && terminalElement.contains(document.activeElement);
				
				if (isTerminalFocused && e.ctrlKey && e.key === 'c' && isExecuting && !isCancelling) {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					// Global Ctrl+C intercepted during execution
					handleCancel();
				}
			};
			
			// Add listener with capture to intercept before bubbling
			document.addEventListener('keydown', handleGlobalKeyDown, true);
			
			// Also listen for custom event from XTerm as backup
			const handleTerminalCancel = (event: Event) => {
				const customEvent = event as CustomEvent;
				// Received terminal-cancel event
				if (isExecuting && !isCancelling) {
					handleCancel();
				}
			};
			
			if (terminalContainer) {
				terminalContainer.addEventListener('terminal-cancel', handleTerminalCancel);
			}
			
			return () => {
				document.removeEventListener('keydown', handleGlobalKeyDown, true);
				terminalContainer?.removeEventListener('terminal-cancel', handleTerminalCancel);
			};
		}
	});

	// Connect to PTY session (initial auto-connect)
	async function connectToPtySession(command: string, terminalSize?: { cols: number; rows: number }) {
		if (!hasActiveProject || !projectId) {
			return;
		}

		// Only connect, ignore command parameter (kept for XTerm compatibility)
		await terminalStore.connectToSession(hasActiveProject ? projectPath : undefined, projectId, terminalSize);
	}

	// Handle keyboard shortcuts
	function handleKeyDown(e: KeyboardEvent) {
		// Handle Ctrl+C to cancel running command
		if (e.ctrlKey && e.key === 'c' && isExecuting) {
			// Ctrl+C pressed - cancelling command
			handleCancel();
		}
	}
	
	// Send Ctrl+C signal to terminal
	// This function always sends the interrupt signal regardless of execution state
	// It's useful as a utility shortcut, especially for mobile accessibility
	async function handleCancel() {
		// UI: Cancel button clicked - sending Ctrl+C signal
		isCancelling = true;

		if (!activeSession) {
			// No active session to send signal
			isCancelling = false;
			return;
		}

		try {
			// Always attempt to send cancel signal to the active session
			// This sends Ctrl+C (\x03) directly to the PTY process
			await terminalStore.cancelCommand();
			// Ctrl+C signal sent to terminal
		} catch (error) {
			// Error sending Ctrl+C signal
		} finally {
			isCancelling = false;
		}
	}

	// Clear terminal session
	function handleClear() {
		if (activeSession) {
			// Clear the terminal store session
			terminalStore.clearSession(activeSession.id);
			
			// Also immediately clear the XTerm display
			if (xterminalRef) {
				xterminalRef.clear();
			}
		}
	}

	// Create new terminal session
	async function handleCloseSession(sessionId: string) {
		// Check if this is the last session before closing
		const isLastSession = terminalStore.sessions.length <= 1;

		// Close the session
		const closed = await terminalStore.closeSession(sessionId);

		// If it was the last session and it was closed successfully, create a new one
		if (closed && isLastSession) {
			await handleNewSession();
		}
	}

	async function handleNewSession() {
		if (!hasActiveProject || !projectId || !projectPath) {
			// Cannot create new terminal: missing project information
			return;
		}

		// Use terminalProjectManager to create new session for current project
		try {
			const { terminalProjectManager } = await import('$frontend/lib/services/terminal');

			// Pass project ID and path directly to ensure it works even if currentProjectId isn't set
			const newSessionId = terminalProjectManager.addTerminalToCurrentProject(projectId, projectPath);

			if (!newSessionId) {
				// If it still fails, try switching to project first then adding
				// Failed to add terminal, switching to project first
				await terminalProjectManager.switchToProject(projectId, projectPath);
				const retrySessionId = terminalProjectManager.addTerminalToCurrentProject(projectId, projectPath);

				if (!retrySessionId) {
					// Final fallback
					// Using fallback terminal creation
					terminalStore.createNewSession(projectPath, projectPath, projectId);
				}
			}
		} catch (error) {
			// Failed to create new terminal session
			// Fallback to direct creation with projectId for proper isolation
			terminalStore.createNewSession(projectPath, projectPath, projectId);
		}
	}

	// Format directory path for display in header
	function formatDirectory(dir: string): string {
		if (!dir || typeof dir !== 'string') return '~';

		// Convert backslashes to forward slashes for consistent display
		const normalizedDir = dir.replace(/\\/g, '/');

		// For long paths, shorten them
		const maxLength = 50;
		if (normalizedDir.length > maxLength) {
			const parts = normalizedDir.split('/');
			if (parts.length > 3) {
				return parts[0] + '/.../' + parts.slice(-1).join('/');
			}
		}

		return normalizedDir;
	}

	// Export actions and state for parent components
	export const terminalActions = {
		handleClear,
		handleNewSession,
		handleCancel,
		getSessions: () => terminalStore.sessions,
		getActiveSession: () => activeSession,
		isExecuting: () => isExecuting,
		isCancelling: () => isCancelling
	};
</script>

<!-- Terminal container -->
<div class="h-full bg-slate-50 dark:bg-slate-950 flex flex-col overflow-hidden min-h-0"
	onkeydown={handleKeyDown}
	tabindex="-1"
	role="application"
	aria-label="Terminal application">

	<!-- Terminal Header with Tabs -->
	<div class="flex-shrink-0 px-3 py-2.5 bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
		<!-- Terminal Tabs -->
		<TerminalTabs
			sessions={terminalStore.sessions}
			activeSessionId={terminalStore.activeSessionId}
			onSwitchSession={(sessionId) => terminalStore.switchToSession(sessionId)}
			onCloseSession={handleCloseSession}
			onNewSession={handleNewSession}
		/>
	</div>

	<!-- Pure XTerminal integration -->
	{#if activeSession}
		<div class="flex-1 relative min-h-0 overflow-hidden font-mono" bind:this={terminalContainer}>
			<XTerm
				bind:this={xterminalRef}
				session={activeSession}
				hasActiveProject={hasActiveProject}
				projectPath={projectPath}
				isExecuting={isExecuting}
				onExecuteCommand={connectToPtySession}
				onClearSession={() => handleClear()}
				class="absolute inset-0"
			/>
		</div>
	{:else}
		<!-- No active session -->
		<div class="flex-1 flex items-center justify-center font-mono">
			<div class="text-center text-slate-600 dark:text-slate-400">
				<p>No terminal sessions available</p>
				<button
					class="mt-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-md transition-colors"
					onclick={handleNewSession}
				>
					Create New Terminal
				</button>
			</div>
		</div>
	{/if}

	<!-- Terminal status bar -->
	<div class="flex-shrink-0 px-2 py-0.5 bg-slate-100 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 text-3xs text-slate-500 dark:text-slate-500 font-mono">
		<div class="flex items-center justify-between">
			<div class="flex items-center space-x-3">
				<span class="hidden sm:inline"><kbd class="px-1 py-0.5 bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded text-3xs text-slate-700 dark:text-slate-300">↑↓</kbd> History</span>
				<span class="hidden md:inline"><kbd class="px-1 py-0.5 bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded text-3xs text-slate-700 dark:text-slate-300">Ctrl+L</kbd> Clear</span>
				<span class="hidden sm:inline"><kbd class="px-1 py-0.5 bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded text-3xs text-slate-700 dark:text-slate-300">{shortcuts.cancel}</kbd> Interrupt
					{#if isCancelling}
						<span class="animate-pulse ml-1">(cancelling...)</span>
					{/if}
				</span>
			</div>
			<div class="flex items-center space-x-1.5">
				{#if hasActiveProject}
					<span class="text-emerald-500 text-xs">●</span>
					<span class="hidden sm:inline">Ready</span>
				{:else}
					<span class="text-amber-500 text-xs">●</span>
					<span class="hidden sm:inline">No Project</span>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	/* Terminal cursor animation */
	@keyframes terminal-cursor {
		0%, 50% { background-color: #22c55e; }
		51%, 100% { background-color: transparent; }
	}

	:global(.animate-terminal-cursor) {
		animation: terminal-cursor 1s infinite;
	}

	/* Terminal scrollbar styling */
	:global(.terminal-scrollbar) {
		scrollbar-width: thin;
		scrollbar-color: rgb(148 163 184 / 0.3) transparent;
	}

	:global(.terminal-scrollbar::-webkit-scrollbar) {
		width: 6px;
	}

	:global(.terminal-scrollbar::-webkit-scrollbar-track) {
		background: transparent;
	}

	:global(.terminal-scrollbar::-webkit-scrollbar-thumb) {
		background-color: rgb(148 163 184 / 0.3);
		border-radius: 3px;
		transition: background-color 0.2s ease;
	}

	:global(.dark .terminal-scrollbar::-webkit-scrollbar-thumb) {
		background-color: rgb(71 85 105 / 0.3);
	}

	:global(.terminal-scrollbar::-webkit-scrollbar-thumb:hover) {
		background-color: rgb(148 163 184 / 0.6);
	}

	:global(.dark .terminal-scrollbar::-webkit-scrollbar-thumb:hover) {
		background-color: rgb(71 85 105 / 0.6);
	}
</style>