<script lang="ts">
	/**
	 * One dialog for both moments of an update.
	 *
	 * Before: what the user would get — every release between the installed
	 * version and the latest, not just the newest three, so skipping versions
	 * does not hide what landed in them. After: the same list for what was just
	 * installed, and how to finish (the server has to restart; this tab reloads
	 * itself once it is back on the new version). Opened while already up to
	 * date (the command palette), it shows the latest few releases.
	 *
	 * The support strip sits in the footer, outside the scrolling notes, so it
	 * is seen without scrolling — this is the one moment users are looking at
	 * what the project has been working on.
	 */
	import Modal from '../overlay/Modal.svelte';
	import Icon from '../display/Icon.svelte';
	import ReleaseNotesList from './ReleaseNotesList.svelte';
	import SupportPanel from '../support/SupportPanel.svelte';
	import {
		updateState, runUpdate, dismissWhatsNew, refetchReleaseNotes, releasesBetween
	} from '$frontend/stores/ui/update.svelte';
	import { REPOSITORY_URL } from '$shared/constants/support';
	import { compareVersions } from '$shared/utils/semver';

	const RECENT_COUNT = 3;

	const installed = $derived(updateState.pendingRestart);
	const available = $derived(!installed && updateState.updateAvailable);
	const fromVersion = $derived(installed ? (updateState.pendingVersions?.from ?? updateState.currentVersion) : available ? updateState.currentVersion : '');
	const toVersion = $derived(
		installed ? (updateState.pendingVersions?.to ?? updateState.latestVersion) : available ? updateState.latestVersion : updateState.currentVersion
	);
	const releases = $derived.by(() => {
		const all = updateState.releaseNotes ?? [];
		if (fromVersion && toVersion) return releasesBetween(all, fromVersion, toVersion);
		// Up to date: the installed release and the ones before it.
		const upTo = toVersion ? all.filter(release => compareVersions(release.version, toVersion) <= 0) : all;
		return upTo.slice(0, RECENT_COUNT);
	});
	const changeCount = $derived(releases.reduce((total, release) => total + release.changes.length, 0));
	const summary = $derived(
		[
			fromVersion && toVersion ? `v${fromVersion} → v${toVersion}` : toVersion ? `You have v${toVersion}, the latest` : '',
			releases.length > 1 ? `${releases.length} releases` : '',
			changeCount ? `${changeCount} ${changeCount === 1 ? 'change' : 'changes'}` : ''
		].filter(Boolean).join(' · ')
	);
	const updateFailed = $derived(updateState.errorType === 'update' && !!updateState.error);
</script>

<Modal
	bind:isOpen={updateState.showWhatsNewModal}
	onClose={dismissWhatsNew}
	bare
	mobileFullscreen
	ariaLabelledBy="whats-new-title"
	className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl w-full max-w-[95vw] md:max-w-xl max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden"
>
	<header class="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-slate-200 dark:border-slate-800">
		<div
			class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0
			{installed ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-violet-500/15 text-violet-600 dark:text-violet-400'}"
		>
			<Icon name={installed ? 'lucide:package-check' : 'lucide:sparkles'} class="w-5 h-5" />
		</div>
		<div class="flex-1 min-w-0">
			<h2 id="whats-new-title" class="text-base font-bold text-slate-900 dark:text-slate-100">
				{installed ? `Clopen updated to v${toVersion}` : available ? `Clopen v${toVersion} is available` : "What's new in Clopen"}
			</h2>
			{#if summary}
				<p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{summary}</p>
			{/if}
		</div>
		<button
			type="button"
			onclick={dismissWhatsNew}
			class="p-1.5 -mr-1.5 -mt-1 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors cursor-pointer"
			aria-label="Close"
		>
			<Icon name="lucide:x" class="w-4 h-4" />
		</button>
	</header>

	<div class="flex-1 min-h-32 overflow-y-auto px-5 py-4">
		{#if installed}
			<div class="mb-4 px-3.5 py-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
				<div class="text-sm font-semibold text-emerald-800 dark:text-emerald-300">Restart Clopen to finish</div>
				<p class="mt-1 text-sm text-slate-700 dark:text-slate-300">
					In the terminal where you ran <code class="px-1 py-0.5 rounded bg-white/70 dark:bg-slate-800 font-mono text-xs">clopen</code>,
					press <kbd class="px-1 py-0.5 rounded border border-slate-300 dark:border-slate-600 bg-white/70 dark:bg-slate-800 font-mono text-xs">Ctrl+C</kbd>,
					then run <code class="px-1 py-0.5 rounded bg-white/70 dark:bg-slate-800 font-mono text-xs">clopen</code> again.
					This tab reloads by itself once the new version is running.
				</p>
				<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Use the terminal Clopen was started from, not a terminal inside Clopen.</p>
			</div>
		{/if}

		{#if updateState.releaseNotesLoading && !releases.length}
			<div class="flex items-center gap-2 text-sm text-slate-500">
				<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
				Loading release notes…
			</div>
		{:else if releases.length}
			<ReleaseNotesList {releases} />
		{:else if updateState.releaseNotesError}
			<div class="flex items-center justify-between gap-3 text-sm">
				<span class="text-red-600 dark:text-red-400">Could not load the release notes.</span>
				<button
					type="button"
					onclick={refetchReleaseNotes}
					class="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline cursor-pointer"
				>
					<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
					Retry
				</button>
			</div>
		{:else}
			<p class="text-sm text-slate-500">
				{toVersion ? `The notes for v${toVersion} are not on GitHub yet.` : 'No release notes to show.'}
				<a href="{REPOSITORY_URL}/releases" target="_blank" rel="noopener noreferrer" class="text-violet-600 dark:text-violet-400 hover:underline">See all releases</a>
			</p>
		{/if}
	</div>

	<footer class="px-5 pt-4 pb-5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/30">
		<SupportPanel compact />

		{#if updateFailed && available}
			<p class="mt-3 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
				<Icon name="lucide:circle-alert" class="w-3.5 h-3.5 shrink-0 mt-px" />
				<span class="min-w-0 break-words">The update failed: {updateState.error}</span>
			</p>
		{/if}

		<div class="flex justify-end gap-2 mt-4">
			{#if !available}
				<button
					type="button"
					onclick={dismissWhatsNew}
					class="px-4 py-2 text-sm font-semibold rounded-lg bg-violet-600 hover:bg-violet-700 text-white transition-colors cursor-pointer"
				>
					Done
				</button>
			{:else}
				<button
					type="button"
					onclick={dismissWhatsNew}
					class="px-4 py-2 text-sm font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
				>
					Later
				</button>
				<button
					type="button"
					onclick={runUpdate}
					disabled={updateState.updating}
					class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-violet-600 enabled:hover:bg-violet-700 text-white transition-colors cursor-pointer disabled:opacity-70 disabled:cursor-default"
				>
					{#if updateState.updating}
						<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
						Updating…
					{:else}
						<Icon name="lucide:download" class="w-4 h-4" />
						{updateFailed ? 'Try again' : 'Update now'}
					{/if}
				</button>
			{/if}
		</div>
	</footer>
</Modal>
