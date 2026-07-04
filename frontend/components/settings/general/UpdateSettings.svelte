<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { systemSettings, updateSystemSettings } from '$frontend/stores/features/settings.svelte';
	import { updateState, checkForUpdate, runUpdate, showRestartModal, fetchReleaseNotes } from '$frontend/stores/ui/update.svelte';
	import Icon from '../../common/display/Icon.svelte';
	import { escapeHtml } from '$frontend/utils/terminal-formatter';
	import { configureMarked, renderCodeBlock, renderInlineCode, renderTable } from '$frontend/utils/markdown-renderer';

	let showReleaseNotes = $state(false);

	configureMarked();

	// Follow the shared markdown pattern (MarkdownPreview / TextMessage): sanitize at the token
	// level via a custom renderer rather than post-sanitizing the whole document. Release notes
	// come from GitHub, so all links open externally.
	const renderer = new marked.Renderer();
	renderer.html = (token) => DOMPurify.sanitize(token.text, { USE_PROFILES: { html: true } });
	renderer.code = (token) => renderCodeBlock(token);
	renderer.codespan = (token) => renderInlineCode(token);
	renderer.link = function (token) {
		const href = escapeHtml(token.href || '');
		const text = this.parser.parseInline(token.tokens);
		const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
		return `<a href="${href}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
	};
	renderer.table = function (token) {
		return renderTable(token, this.parser);
	};

	const renderedReleaseNotes = $derived(
		updateState.releaseNotes ? (marked.parse(updateState.releaseNotes.body, { renderer }) as string) : ''
	);

	const releaseDate = $derived(
		updateState.releaseNotes?.published_at
			? new Date(updateState.releaseNotes.published_at).toLocaleDateString(undefined, {
					year: 'numeric',
					month: 'short',
					day: 'numeric'
				})
			: ''
	);

	const releaseSubtitle = $derived(
		updateState.releaseNotes
			? [updateState.releaseNotes.tag_name, releaseDate].filter(Boolean).join(' · ')
			: "What's new in the latest version"
	);

	function toggleAutoUpdate() {
		updateSystemSettings({ autoUpdate: !systemSettings.autoUpdate });
	}

	function handleCheckNow() {
		checkForUpdate();
	}

	function handleUpdateNow() {
		runUpdate();
	}

	function handleToggleReleaseNotes() {
		showReleaseNotes = !showReleaseNotes;
		if (showReleaseNotes && !updateState.releaseNotes && !updateState.releaseNotesLoading) {
			fetchReleaseNotes();
		}
	}

	function handleRetryReleaseNotes() {
		fetchReleaseNotes();
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Updates</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">Check for new versions and configure automatic updates</p>

	<div class="flex flex-col gap-3.5">
		<!-- Version Info -->
		<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
			<div class="flex items-center gap-3.5">
				<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-violet-400/15 text-violet-500">
					<Icon name="lucide:package" class="w-5 h-5" />
				</div>
				<div class="flex flex-col gap-0.5 min-w-0 flex-1">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">
						@myrialabs/clopen
					</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">
						{#if updateState.currentVersion}
							Current version: <span class="font-mono font-medium text-slate-700 dark:text-slate-400">v{updateState.currentVersion}</span>
						{:else}
							Version info will appear after checking
						{/if}
					</div>
					{#if updateState.updateAvailable}
						<div class="text-xs">
							<span class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-violet-500/15 text-violet-600 dark:text-violet-400 rounded text-2xs font-semibold">
								v{updateState.latestVersion} available
							</span>
						</div>
					{/if}
				</div>

				<div class="flex items-center gap-2 shrink-0">
					{#if updateState.updateAvailable}
						<button
							type="button"
							onclick={handleUpdateNow}
							disabled={updateState.updating}
							class="inline-flex items-center gap-1.5 py-2 px-3.5 bg-violet-500/10 border border-violet-500/20 rounded-lg text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20 hover:border-violet-600/40 disabled:opacity-60 disabled:cursor-not-allowed"
						>
							{#if updateState.updating}
								<div class="w-3.5 h-3.5 border-2 border-violet-600/30 border-t-violet-600 rounded-full animate-spin"></div>
								Updating...
							{:else}
								<Icon name="lucide:download" class="w-3.5 h-3.5" />
								Update
							{/if}
						</button>
					{/if}
					<button
						type="button"
						onclick={handleCheckNow}
						disabled={updateState.checking}
						class="inline-flex items-center gap-1.5 py-2 px-3.5 bg-slate-200/80 dark:bg-slate-700/80 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-700 dark:text-slate-300 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-60 disabled:cursor-not-allowed"
					>
						{#if updateState.checking}
							<div class="w-3.5 h-3.5 border-2 border-slate-600/30 border-t-slate-600 dark:border-slate-400/30 dark:border-t-slate-400 rounded-full animate-spin"></div>
							Checking...
						{:else}
							<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
							Check now
						{/if}
					</button>
				</div>
			</div>

			{#if updateState.error}
				<div class="mt-3 flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
					<Icon name="lucide:circle-alert" class="w-4 h-4 text-red-500 shrink-0" />
					<span class="text-xs text-red-600 dark:text-red-400">{updateState.error}</span>
				</div>
			{/if}

			{#if updateState.updateSuccess || updateState.pendingRestart}
				<div class="mt-3 flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
					<Icon name="lucide:circle-check" class="w-4 h-4 text-emerald-500 shrink-0" />
					<span class="text-xs text-emerald-600 dark:text-emerald-400">Updated to v{updateState.latestVersion} — restart required</span>
					<button
						type="button"
						onclick={() => showRestartModal()}
						class="text-xs font-semibold text-emerald-600 dark:text-emerald-400 underline underline-offset-2 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors"
					>
						How to restart
					</button>
				</div>
			{/if}
		</div>

		<!-- Release Notes -->
		<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
			<button
				type="button"
				onclick={handleToggleReleaseNotes}
				aria-expanded={showReleaseNotes}
				class="flex items-center justify-between w-full text-left cursor-pointer"
			>
				<div class="flex items-center gap-3">
					<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-amber-400/15 text-amber-500">
						<Icon name="lucide:book-marked" class="w-5 h-5" />
					</div>
					<div>
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Release Notes</div>
						<div class="text-xs text-slate-600 dark:text-slate-500">
							{releaseSubtitle}
						</div>
					</div>
				</div>
				<Icon name={showReleaseNotes ? 'lucide:chevron-up' : 'lucide:chevron-down'} class="w-4.5 h-4.5 text-slate-500" />
			</button>

			{#if showReleaseNotes}
				<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
					{#if updateState.releaseNotesLoading}
						<div class="flex items-center gap-2 text-xs text-slate-500">
							<div class="w-3.5 h-3.5 border-2 border-slate-500/30 border-t-slate-500 rounded-full animate-spin"></div>
							Loading release notes...
						</div>
					{:else if updateState.releaseNotes}
						<div class="release-notes-content text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
							{@html renderedReleaseNotes}
						</div>
						<div class="mt-3">
							<a
								href={updateState.releaseNotes.html_url}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline"
							>
								<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
								View on GitHub
							</a>
						</div>
					{:else if updateState.releaseNotesError}
						<div class="flex items-center justify-between gap-3">
							<div class="flex items-center gap-2 min-w-0">
								<Icon name="lucide:circle-alert" class="w-4 h-4 text-red-500 shrink-0" />
								<span class="text-xs text-red-600 dark:text-red-400 truncate">Could not load release notes. Check your connection.</span>
							</div>
							<button
								type="button"
								onclick={handleRetryReleaseNotes}
								class="inline-flex items-center gap-1.5 shrink-0 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline cursor-pointer"
							>
								<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
								Retry
							</button>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Auto-Update Toggle -->
		<div class="flex items-center justify-between gap-4 py-3 px-4 bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 rounded-lg">
			<div class="flex items-center gap-3">
				<Icon name="lucide:refresh-cw" class="w-4.5 h-4.5 text-slate-600 dark:text-slate-400" />
				<div class="text-left">
					<div class="text-sm font-medium text-slate-900 dark:text-slate-100">Auto-update</div>
					<div class="text-xs text-slate-600 dark:text-slate-400">Automatically install new versions when available</div>
				</div>
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={systemSettings.autoUpdate}
				onclick={toggleAutoUpdate}
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
</div>

<style>
	.release-notes-content :global(h1),
	.release-notes-content :global(h2),
	.release-notes-content :global(h3) {
		font-weight: 600;
		margin-top: 0.75rem;
		margin-bottom: 0.375rem;
		font-size: inherit;
	}
	.release-notes-content :global(h1) { font-size: 1rem; }
	.release-notes-content :global(h2) { font-size: 0.875rem; }
	.release-notes-content :global(h3) { font-size: 0.8125rem; }
	.release-notes-content :global(ul),
	.release-notes-content :global(ol) {
		padding-left: 1.25rem;
		margin-top: 0.25rem;
		margin-bottom: 0.25rem;
		list-style-position: outside;
	}
	.release-notes-content :global(ul) { list-style-type: disc; }
	.release-notes-content :global(ol) { list-style-type: decimal; }
	.release-notes-content :global(li) { margin-bottom: 0.125rem; }
	.release-notes-content :global(p) { margin-top: 0.375rem; margin-bottom: 0.375rem; }
	.release-notes-content :global(code) {
		font-size: 0.75rem;
		padding: 0.125rem 0.25rem;
		border-radius: 0.25rem;
		background: rgb(148 163 184 / 0.15);
	}
	.release-notes-content :global(pre) {
		margin-top: 0.5rem;
		margin-bottom: 0.5rem;
		padding: 0.75rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		background: rgb(148 163 184 / 0.1);
	}
	.release-notes-content :global(pre code) {
		padding: 0;
		background: none;
	}
	.release-notes-content :global(a) {
		color: rgb(139 92 246);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.release-notes-content :global(a:hover) {
		color: rgb(124 58 237);
	}
	.release-notes-content :global(blockquote) {
		border-left: 2px solid rgb(148 163 184 / 0.3);
		padding-left: 0.75rem;
		margin-top: 0.5rem;
		margin-bottom: 0.5rem;
		color: rgb(100 116 139);
	}
	.release-notes-content :global(hr) {
		margin-top: 0.75rem;
		margin-bottom: 0.75rem;
		border-color: rgb(148 163 184 / 0.2);
	}
	.release-notes-content :global(img) {
		max-width: 100%;
		border-radius: 0.5rem;
		margin-top: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.release-notes-content :global(.table-responsive) {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		margin-top: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.release-notes-content :global(table) {
		width: 100%;
		border-collapse: collapse;
	}
	.release-notes-content :global(th),
	.release-notes-content :global(td) {
		padding: 0.375rem 0.5rem;
		border: 1px solid rgb(148 163 184 / 0.2);
		text-align: left;
	}
</style>
