<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MonacoEditor from '$frontend/components/common/editor/MonacoEditor.svelte';
	import {
		dbSnippetsState,
		closePreview,
		deleteSnippet,
		generateShareLink,
		revokeShareLink,
		openForm
	} from '$frontend/stores/features/db-sql-snippets.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';

	interface Props {
		onInsert: (sql: string) => void;
		onRun: (sql: string) => void;
	}

	let { onInsert, onRun }: Props = $props();

	const snippet = $derived(dbSnippetsState.previewSnippet);
	const isOwner = $derived(snippet?.createdBy === authStore.currentUser?.id);
	const isSharing = $derived(dbSnippetsState.sharingId === snippet?.id);

	let copiedLink = $state(false);

	async function handleCopyLink() {
		if (!snippet?.shareToken) return;
		const url = `${window.location.origin}${window.location.pathname}#snippet/${snippet.shareToken}`;
		await navigator.clipboard.writeText(url);
		copiedLink = true;
		setTimeout(() => { copiedLink = false; }, 2000);
	}

	async function handleGenerateLink() {
		if (!snippet) return;
		await generateShareLink(snippet.id);
	}

	async function handleRevokeLink() {
		if (!snippet) return;
		await revokeShareLink(snippet.id);
	}

	async function handleDelete() {
		if (!snippet) return;
		await deleteSnippet(snippet.id);
	}

	function handleInsert() {
		if (!snippet) return;
		const sql = snippet.sql; // capture before closePreview() nullifies the $derived
		closePreview();
		onInsert(sql);
	}

	function handleRun() {
		if (!snippet) return;
		const sql = snippet.sql; // capture before closePreview() nullifies the $derived
		closePreview();
		onRun(sql);
	}

	function handleEdit() {
		if (!snippet) return;
		openForm(snippet);
		closePreview();
	}
</script>

{#if dbSnippetsState.isPreviewOpen && snippet}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		role="none"
		onclick={closePreview}
	>
		<div
			class="relative flex flex-col w-full max-w-2xl max-h-[90vh] rounded-xl bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
			role="dialog"
			aria-modal="true"
			onclick={(e) => e.stopPropagation()}
			onkeydown={undefined}
		>
			<!-- Header -->
			<div class="flex items-start justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<Icon name="lucide:code" class="w-4 h-4 text-violet-500 shrink-0" />
						<h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
							{snippet.title}
						</h2>
						{#if snippet.isPublic}
							<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 shrink-0">
								<Icon name="lucide:users" class="w-2.5 h-2.5" />
								Team
							</span>
						{/if}
					</div>
					{#if snippet.description}
						<p class="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">{snippet.description}</p>
					{/if}
					{#if snippet.tags.length > 0}
						<div class="flex flex-wrap gap-1 mt-2">
							{#each snippet.tags as tag}
								<span class="px-1.5 py-0.5 rounded-full text-xs bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400">
									{tag}
								</span>
							{/each}
						</div>
					{/if}
				</div>
				<button
					type="button"
					class="ml-3 p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
					onclick={closePreview}
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>

			<!-- Mini SQL Editor (read-only preview with syntax highlighting) -->
			<div class="border-b border-slate-200 dark:border-slate-800 shrink-0" style="height: 220px;">
				<MonacoEditor
					value={snippet.sql}
					language="sql"
					height="100%"
					options={{
						readOnly: true,
						lineNumbers: 'on',
						minimap: { enabled: false },
						scrollBeyondLastLine: false,
						padding: { top: 8, bottom: 8 },
						fontSize: 12,
						renderLineHighlight: 'none',
						contextmenu: false
					}}
				/>
			</div>

			<!-- Share section (owner only) -->
			{#if isOwner}
				<div class="px-5 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50 dark:bg-slate-900/30">
					<p class="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">Share link</p>
					{#if snippet.shareToken}
						<div class="flex items-center gap-2">
							<div class="flex-1 px-2.5 py-1.5 text-xs font-mono text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md truncate select-all">
								{window.location.origin}{window.location.pathname}#snippet/{snippet.shareToken}
							</div>
							<button
								type="button"
								class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shrink-0"
								onclick={handleCopyLink}
							>
								<Icon name={copiedLink ? 'lucide:check' : 'lucide:copy'} class="w-3 h-3 {copiedLink ? 'text-emerald-500' : ''}" />
								{copiedLink ? 'Copied!' : 'Copy'}
							</button>
							<button
								type="button"
								class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-red-200 dark:border-red-800 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0 disabled:opacity-50"
								onclick={handleRevokeLink}
								disabled={isSharing}
							>
								<Icon name="lucide:link-2-off" class="w-3 h-3" />
								Revoke
							</button>
						</div>
					{:else}
						<button
							type="button"
							class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-900/50 transition-colors disabled:opacity-50"
							onclick={handleGenerateLink}
							disabled={isSharing}
						>
							{#if isSharing}
								<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
									<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
									<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
								</svg>
								Generating…
							{:else}
								<Icon name="lucide:link-2" class="w-3 h-3" />
								Generate share link
							{/if}
						</button>
					{/if}
				</div>
			{/if}

			<!-- Footer actions -->
			<div class="flex items-center justify-between px-5 py-3 shrink-0">
				<!-- Meta -->
				<div class="flex items-center gap-1.5 text-xs text-slate-400">
					<Icon name="lucide:user" class="w-3 h-3" />
					{snippet.createdByName}
					<span class="mx-1">·</span>
					{new Date(snippet.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
				</div>

				<div class="flex items-center gap-2">
					{#if isOwner}
						<button
							type="button"
							class="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
							onclick={handleDelete}
							title="Delete snippet"
						>
							<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
							onclick={handleEdit}
						>
							<Icon name="lucide:pencil" class="w-3 h-3" />
							Edit
						</button>
					{/if}
					<!-- Insert: loads SQL into editor, stays on snippets tab -->
					<button
						type="button"
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 transition-colors"
						onclick={handleInsert}
					>
						<Icon name="lucide:corner-down-left" class="w-3 h-3" />
						Insert
					</button>
					<!-- Run: executes the snippet query directly and shows results -->
					<button
						type="button"
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
						onclick={handleRun}
					>
						<Icon name="lucide:play" class="w-3 h-3" />
						Run
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
