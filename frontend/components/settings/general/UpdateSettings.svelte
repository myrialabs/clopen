<script lang="ts">
	/**
	 * Settings → Updates. One status card that is always in exactly one state
	 * (up to date, available, installing, restart needed, failed), the auto-update
	 * switch beside it, and the release history open below — the history is why
	 * most people come here, so it is not tucked behind an accordion.
	 */
	import { onMount } from 'svelte';
	import { systemSettings, updateSystemSettings } from '$frontend/stores/features/settings.svelte';
	import {
		updateState, checkForUpdate, runUpdate, openWhatsNew, fetchReleaseNotes, refetchReleaseNotes, releasesBetween
	} from '$frontend/stores/ui/update.svelte';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import { formatRelativeTime } from '$frontend/utils/format';
	import { REPOSITORY_URL } from '$shared/constants/support';
	import { compareVersions } from '$shared/utils/semver';
	import Icon from '../../common/display/Icon.svelte';
	import ReleaseNotesList from '../../common/feedback/ReleaseNotesList.svelte';

	const HISTORY_PAGE = 8;

	let historyLimit = $state(HISTORY_PAGE);
	let now = $state(Date.now());

	onMount(() => {
		fetchReleaseNotes();
		const timer = setInterval(() => { now = Date.now(); }, 30_000);
		return () => clearInterval(timer);
	});

	type Status = 'loading' | 'restart' | 'installing' | 'available' | 'failed' | 'current';

	const status = $derived<Status>(
		updateState.pendingRestart ? 'restart'
			: updateState.updating ? 'installing'
				: updateState.updateAvailable ? 'available'
					: updateState.error ? 'failed'
						: updateState.currentVersion ? 'current'
							: 'loading'
	);

	const releases = $derived(updateState.releaseNotes ?? []);
	const history = $derived(releases.slice(0, historyLimit));
	const behind = $derived(
		updateState.currentVersion && updateState.latestVersion
			? releasesBetween(releases, updateState.currentVersion, updateState.latestVersion).length
			: 0
	);
	const installedRelease = $derived(
		releases.find(release => updateState.currentVersion && compareVersions(release.version, updateState.currentVersion) === 0)
	);
	const lastChecked = $derived(
		updateState.lastCheckedAt ? formatRelativeTime(new Date(updateState.lastCheckedAt).toISOString(), now) : ''
	);

	const TONES: Record<Status, { icon: 'lucide:loader-circle' | 'lucide:package-check' | 'lucide:sparkles' | 'lucide:circle-alert' | 'lucide:circle-check'; tile: string }> = {
		loading: { icon: 'lucide:loader-circle', tile: 'bg-slate-500/10 text-slate-500' },
		restart: { icon: 'lucide:package-check', tile: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
		installing: { icon: 'lucide:loader-circle', tile: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
		available: { icon: 'lucide:sparkles', tile: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
		failed: { icon: 'lucide:circle-alert', tile: 'bg-red-500/15 text-red-600 dark:text-red-400' },
		current: { icon: 'lucide:circle-check', tile: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' }
	};
	const tone = $derived(TONES[status]);

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}
</script>

<div class="py-1">
	<div class="flex items-start justify-between gap-3 mb-4">
		<div class="min-w-0">
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1">Updates</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500 truncate">
				{#if updateState.checking}
					Checking for updates…
				{:else if lastChecked}
					Checked {lastChecked}
				{:else}
					New versions of Clopen and what changed in them
				{/if}
			</p>
		</div>
		<button
			type="button"
			onclick={checkForUpdate}
			disabled={updateState.checking || updateState.updating}
			class="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 enabled:hover:border-violet-500/40 enabled:hover:text-violet-600 dark:enabled:hover:text-violet-400 transition-colors cursor-pointer disabled:opacity-50"
		>
			<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5 {updateState.checking ? 'animate-spin' : ''}" />
			Check now
		</button>
	</div>

	<div class="flex flex-col gap-5">
		<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
			<div class="flex flex-wrap items-center gap-3.5 px-4 py-3.5">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 {tone.tile}">
					<Icon name={tone.icon} class="w-5 h-5 {status === 'loading' || status === 'installing' ? 'animate-spin' : ''}" />
				</div>

				<div class="flex-1 min-w-48">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">
						{#if status === 'restart'}
							v{updateState.latestVersion} is installed
						{:else if status === 'installing'}
							Installing v{updateState.latestVersion}…
						{:else if status === 'available'}
							v{updateState.latestVersion} is available
						{:else if status === 'failed'}
							{updateState.errorType === 'check' ? 'Could not check for updates' : 'The update failed'}
						{:else if status === 'current'}
							You're up to date
						{:else}
							Checking your version…
						{/if}
					</div>
					<div class="text-xs text-slate-600 dark:text-slate-500 mt-0.5">
						{#if status === 'restart'}
							Restart Clopen to start using it
						{:else if status === 'available'}
							You have v{updateState.currentVersion}{behind > 1 ? ` · ${behind} releases behind` : ''}
						{:else if status === 'failed'}
							<span class="break-words">{updateState.error}</span>
						{:else if updateState.currentVersion}
							v{updateState.currentVersion}{installedRelease?.publishedAt ? ` · released ${formatDate(installedRelease.publishedAt)}` : ''}
						{/if}
					</div>
				</div>

				<div class="flex items-center gap-2 shrink-0">
					{#if status === 'restart'}
						<button
							type="button"
							onclick={openWhatsNew}
							class="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors cursor-pointer"
						>
							How to finish
						</button>
					{:else if status === 'available' || (status === 'failed' && updateState.errorType === 'update')}
						<button
							type="button"
							onclick={openWhatsNew}
							class="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
						>
							What's new
						</button>
						<button
							type="button"
							onclick={runUpdate}
							class="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-violet-600 hover:bg-violet-700 text-white transition-colors cursor-pointer"
						>
							<Icon name="lucide:download" class="w-3.5 h-3.5" />
							{status === 'failed' ? 'Try again' : 'Update now'}
						</button>
					{/if}
				</div>
			</div>

			<div class="flex items-center justify-between gap-4 px-4 py-3 border-t border-slate-200 dark:border-slate-700/50">
				<div>
					<div class="text-sm font-medium text-slate-900 dark:text-slate-100">Install updates automatically</div>
					<div class="text-xs text-slate-600 dark:text-slate-400">New versions download as soon as they are out; a restart finishes them</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={systemSettings.autoUpdate}
					aria-label="Install updates automatically"
					onclick={() => updateSystemSettings({ autoUpdate: !systemSettings.autoUpdate })}
					class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-violet-500/30
						{systemSettings.autoUpdate ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'}"
				>
					<span
						class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out
							{systemSettings.autoUpdate ? 'translate-x-5' : 'translate-x-0'}"
					></span>
				</button>
			</div>
		</div>

		<div>
			<div class="flex items-center justify-between gap-3 mb-2">
				<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Release history</div>
				<a
					href="{REPOSITORY_URL}/releases"
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
				>
					All releases
					<Icon name="lucide:external-link" class="w-3 h-3" />
				</a>
			</div>

			<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 px-4 py-3.5">
				{#if updateState.releaseNotesLoading && !releases.length}
					<div class="flex items-center gap-2 text-xs text-slate-500">
						<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
						Loading release notes…
					</div>
				{:else if releases.length}
					<ReleaseNotesList releases={history} currentVersion={updateState.currentVersion} collapsible />
					{#if releases.length > historyLimit}
						<button
							type="button"
							onclick={() => (historyLimit += HISTORY_PAGE)}
							class="mt-3 w-full py-1.5 text-xs font-semibold rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
						>
							Show older releases
						</button>
					{/if}
				{:else if updateState.releaseNotesError}
					<div class="flex items-center justify-between gap-3">
						<span class="text-xs text-red-600 dark:text-red-400">Could not load the release notes. Check your connection.</span>
						<button
							type="button"
							onclick={refetchReleaseNotes}
							class="inline-flex items-center gap-1.5 shrink-0 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline cursor-pointer"
						>
							<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
							Retry
						</button>
					</div>
				{:else}
					<p class="text-xs text-slate-500">No releases to show.</p>
				{/if}
			</div>
		</div>

		<button
			type="button"
			onclick={() => setActiveSection('support')}
			class="flex items-center gap-3 px-4 py-3 rounded-xl border border-rose-500/20 bg-rose-500/5 hover:bg-rose-500/10 text-left transition-colors cursor-pointer"
		>
			<Icon name="lucide:heart" class="w-4.5 h-4.5 text-rose-500 shrink-0" />
			<div class="flex-1 min-w-0">
				<div class="text-sm font-medium text-slate-900 dark:text-slate-100">Enjoying Clopen?</div>
				<div class="text-xs text-slate-600 dark:text-slate-400">Every release is built in the open. Support its development.</div>
			</div>
			<Icon name="lucide:chevron-right" class="w-4 h-4 text-slate-400 shrink-0" />
		</button>
	</div>
</div>
