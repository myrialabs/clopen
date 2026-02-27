<script lang="ts">
	import { initializeProjects, projectState } from '$frontend/lib/stores/core/projects.svelte';
	import { initializeStore } from '$frontend/lib/stores/core/app.svelte';
	import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import { settings, resetToDefaults } from '$frontend/lib/stores/features/settings.svelte';
	import { showConfirm } from '$frontend/lib/stores/ui/dialog.svelte';
	import { terminalStore } from '$frontend/lib/stores/features/terminal.svelte';
	import Icon from '../../common/Icon.svelte';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/lib/utils/ws';

	let isExporting = $state(false);
	let isClearing = $state(false);

	async function clearData() {
		const confirmed = await showConfirm({
			title: 'Clear All Data',
			message:
				'Are you sure you want to clear all data? This will delete all projects, sessions, and settings. This action cannot be undone.',
			type: 'error',
			confirmText: 'Clear All Data',
			cancelText: 'Cancel'
		});

		if (confirmed) {
			isClearing = true;
			try {
				localStorage.clear();
				sessionStorage.clear();

				const response = await ws.http('system:clear-data', {});

				if (response.cleared) {
					terminalStore.clearAllSessions();
					projectState.currentProject = null;
					await initializeProjects();
					await initializeStore();
					resetToDefaults();

					addNotification({
						type: 'success',
						title: 'Data Cleared',
						message: 'All data has been cleared successfully'
					});
				}
			} catch (error) {
				debug.error('settings', 'Error clearing data:', error);
				addNotification({
					type: 'error',
					title: 'Clear Data Error',
					message: 'Failed to clear all data',
					duration: 4000
				});
			} finally {
				isClearing = false;
			}
		}
	}

	async function exportData() {
		isExporting = true;
		try {
			const [projects, sessions, messages] = await Promise.all([
				ws.http('projects:list', {}),
				ws.http('sessions:list', {}),
				ws.http('messages:list', { session_id: '', include_all: true })
			]);

			const data = {
				projects: projects || projectState.projects,
				sessions: sessions || sessionState.sessions,
				messages: messages || sessionState.messages,
				settings: settings,
				exportedAt: new Date().toISOString(),
				version: '1.0'
			};

			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `clopen-data-${new Date().toISOString().split('T')[0]}.json`;
			a.click();
			URL.revokeObjectURL(url);

			addNotification({
				type: 'success',
				title: 'Export Complete',
				message: 'Your data has been exported successfully'
			});
		} catch (error) {
			debug.error('settings', 'Export error:', error);
			addNotification({
				type: 'error',
				title: 'Export Error',
				message: 'Failed to export data',
				duration: 4000
			});
		} finally {
			isExporting = false;
		}
	}

	async function resetSettings() {
		const confirmed = await showConfirm({
			title: 'Reset Settings',
			message:
				'Are you sure you want to reset all settings to defaults? This will not delete your projects or conversations.',
			type: 'warning',
			confirmText: 'Reset Settings',
			cancelText: 'Cancel'
		});

		if (confirmed) {
			resetToDefaults();
			addNotification({
				type: 'success',
				title: 'Settings Reset',
				message: 'All settings have been restored to defaults'
			});
		}
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Data Management</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		Export, import, or clear your application data
	</p>

	<div class="flex flex-col gap-4">
		<!-- Storage Info -->
		<div
			class="flex items-center gap-3.5 p-4 bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 rounded-lg"
		>
			<Icon name="lucide:hard-drive" class="w-5 h-5 text-slate-500 dark:text-slate-400" />
			<div class="flex-1">
				<div class="text-sm font-medium text-slate-900 dark:text-slate-100">Local Storage</div>
				<div class="text-xs text-slate-600 dark:text-slate-400">Data is stored locally in your browser</div>
			</div>
		</div>

		<!-- Action Cards -->
		<div class="flex flex-col gap-3">
			<!-- Reset Settings -->
			<div
				class="flex items-center justify-between gap-4 py-3 px-4 bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 rounded-lg"
			>
				<div class="flex items-center gap-3">
					<Icon name="lucide:refresh-cw" class="w-4.5 h-4.5 text-slate-600 dark:text-slate-400" />
					<div class="text-left">
						<div class="text-sm font-medium text-slate-900 dark:text-slate-100">Reset Settings</div>
						<div class="text-xs text-slate-600 dark:text-slate-400">Restore default settings</div>
					</div>
				</div>
				<button
					type="button"
					class="px-4 py-2 bg-slate-200 dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 rounded-lg text-sm font-medium cursor-pointer transition-all duration-150 hover:bg-slate-300 dark:hover:bg-slate-600 hover:border-slate-400 dark:hover:border-slate-500 disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
					onclick={resetSettings}
				>
					Reset
				</button>
			</div>
		</div>

		<!-- Danger Zone -->
		<div class="mt-2">
			<div class="flex items-center gap-2 mb-3 text-xs font-medium text-red-600 dark:text-red-400">
				<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
				<span>Danger Zone</span>
			</div>
			<div
				class="flex items-center justify-between gap-4 p-4 bg-red-500/5 dark:bg-red-500/5 border border-red-500/20 dark:border-red-500/20 rounded-lg max-sm:flex-col max-sm:items-stretch"
			>
				<div class="flex-1">
					<div class="text-sm font-medium text-slate-900 dark:text-slate-100 mb-1">
						Clear All Data
					</div>
					<div class="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
						Permanently delete all projects, conversations, and settings. This cannot be undone.
					</div>
				</div>
				<button
					type="button"
					class="flex items-center justify-center gap-2 py-2 px-4 bg-red-500/10 border border-red-500/25 rounded-lg text-red-600 dark:text-red-400 text-sm font-medium cursor-pointer transition-all duration-150 whitespace-nowrap hover:bg-red-500/15 hover:border-red-500/35 disabled:opacity-60 disabled:cursor-not-allowed"
					onclick={clearData}
					disabled={isClearing}
				>
					{#if isClearing}
						<div
							class="w-3.5 h-3.5 border-2 border-red-600/30 dark:border-red-400/30 border-t-red-600 dark:border-t-red-400 rounded-full animate-spin"
						></div>
						<span>Clearing...</span>
					{:else}
						<Icon name="lucide:trash-2" class="w-4 h-4" />
						<span>Clear All Data</span>
					{/if}
				</button>
			</div>
		</div>
	</div>
</div>
