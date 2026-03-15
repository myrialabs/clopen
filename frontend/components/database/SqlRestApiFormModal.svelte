<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbRestApiState,
		closeForm,
		createEndpoint,
		updateEndpoint,
		extractParams
	} from '$frontend/stores/features/db-sql-rest-api.svelte';
	import type { SqlApiParam, SqlApiParamType } from '$shared/types/sql-rest-api';

	interface Props {
		connectionId: string;
	}

	let { connectionId }: Props = $props();

	const isEdit = $derived(!!dbRestApiState.editEndpoint);

	// ── Form state ─────────────────────────────────────────────────────────────
	let name = $state('');
	let description = $state('');
	let slug = $state('');
	let sqlTemplate = $state('');
	let isPublic = $state(false);
	let enabled = $state(true);
	let rateLimitRequests = $state(60);
	let rateLimitWindowSecs = $state(60);
	let cacheTtlSecs = $state(0);
	let params = $state<SqlApiParam[]>([]);
	let isSaving = $state(false);
	let extracting = $state(false);

	// ── Slug auto-generation ───────────────────────────────────────────────────
	function toSlug(s: string): string {
		return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	}

	function onNameInput(e: Event) {
		name = (e.target as HTMLInputElement).value;
		if (!isEdit) slug = toSlug(name);
	}

	// ── Param helpers ──────────────────────────────────────────────────────────
	function addParam(): void {
		params = [...params, { name: '', type: 'string', description: '', required: true }];
	}

	function removeParam(index: number): void {
		params = params.filter((_, i) => i !== index);
	}

	function updateParam(index: number, field: keyof SqlApiParam, value: string | boolean): void {
		params = params.map((p, i) => (i === index ? { ...p, [field]: value } : p));
	}

	async function autoExtractParams(): Promise<void> {
		if (!sqlTemplate.trim()) return;
		extracting = true;
		try {
			const discovered = await extractParams(sqlTemplate);
			// Merge — keep existing ones, add new
			const existingNames = new Set(params.map((p) => p.name));
			const newParams = discovered.filter((p) => !existingNames.has(p.name));
			params = [...params, ...newParams];
		} finally {
			extracting = false;
		}
	}

	// ── Populate form whenever the modal opens ─────────────────────────────────
	// Using $effect (not onMount) because the component is always mounted;
	// only the {#if} inside toggles visibility — so onMount only ran once.
	$effect(() => {
		if (!dbRestApiState.isFormOpen) return;
		const ep = dbRestApiState.editEndpoint;
		if (ep) {
			name = ep.name;
			description = ep.description;
			slug = ep.slug;
			sqlTemplate = ep.sqlTemplate;
			isPublic = ep.isPublic;
			enabled = ep.enabled;
			rateLimitRequests = ep.rateLimitRequests;
			rateLimitWindowSecs = ep.rateLimitWindowSecs;
			cacheTtlSecs = ep.cacheTtlSecs;
			params = ep.params.map((p) => ({ ...p }));
		} else {
			// Reset to defaults for new endpoint
			name = '';
			description = '';
			slug = '';
			sqlTemplate = '';
			isPublic = false;
			enabled = true;
			rateLimitRequests = 60;
			rateLimitWindowSecs = 60;
			cacheTtlSecs = 0;
			params = [];
		}
	});

	// ── Submit ─────────────────────────────────────────────────────────────────
	async function handleSubmit(e: Event): Promise<void> {
		e.preventDefault();
		isSaving = true;
		try {
			const payload = {
				connectionId,
				name,
				description,
				slug,
				sqlTemplate,
				params,
				isPublic,
				rateLimitRequests,
				rateLimitWindowSecs,
				cacheTtlSecs
			};
			let ok: boolean;
			if (isEdit && dbRestApiState.editEndpoint) {
				ok = await updateEndpoint({ ...payload, id: dbRestApiState.editEndpoint.id, enabled });
			} else {
				ok = await createEndpoint(payload);
			}
			if (ok) closeForm();
		} finally {
			isSaving = false;
		}
	}
</script>

{#if dbRestApiState.isFormOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/50"
		role="dialog"
		aria-modal="true"
	>
		<div class="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl flex flex-col max-h-[90vh]">

			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="flex items-center gap-2">
					<Icon name="lucide:cable" class="w-4 h-4 text-violet-500" />
					<h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
						{isEdit ? 'Edit REST API Endpoint' : 'New REST API Endpoint'}
					</h2>
				</div>
				<button
					type="button"
					onclick={closeForm}
					class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>

			<!-- Body (scrollable) -->
			<form class="flex-1 min-h-0 overflow-y-auto p-5 space-y-5" onsubmit={handleSubmit}>

				<!-- Name + Slug row -->
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Name *</label>
						<input
							type="text"
							value={name}
							oninput={onNameInput}
							required
							placeholder="Get users by status"
							class="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
						/>
					</div>
					<div>
						<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
							Slug * <span class="text-slate-400 font-normal">(used in URL)</span>
						</label>
						<div class="flex items-center gap-1">
							<span class="text-xs text-slate-400">/sql-api/</span>
							<input
								type="text"
								bind:value={slug}
								required
								pattern="[a-z0-9-]+"
								placeholder="get-users-by-status"
								class="flex-1 px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
							/>
						</div>
					</div>
				</div>

				<!-- Description -->
				<div>
					<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Description</label>
					<input
						type="text"
						bind:value={description}
						placeholder="Returns users filtered by status"
						class="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
					/>
				</div>

				<!-- SQL Template -->
				<div>
					<div class="flex items-center justify-between mb-1">
						<label class="block text-xs font-medium text-slate-600 dark:text-slate-400">
							SQL Template *
							<span class="text-slate-400 font-normal ml-1">— use {'{{param_name}}'} for dynamic values</span>
						</label>
						<button
							type="button"
							onclick={autoExtractParams}
							disabled={extracting || !sqlTemplate.trim()}
							class="flex items-center gap-1 text-xs text-violet-500 hover:text-violet-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
						>
							<Icon name="lucide:wand" class="w-3 h-3" />
							{extracting ? 'Detecting…' : 'Auto-detect params'}
						</button>
					</div>
					<textarea
						bind:value={sqlTemplate}
						required
						rows={5}
						placeholder={'SELECT * FROM users WHERE status = {{status}} AND id = {{user_id}}'}
						spellcheck="false"
						class="w-full px-3 py-2 text-xs font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 resize-y"
					></textarea>
					<p class="mt-1 text-xs text-slate-400">Only SELECT queries are permitted. Parameters are injected safely — SQL injection is prevented.</p>
				</div>

				<!-- Parameters -->
				<div>
					<div class="flex items-center justify-between mb-2">
						<label class="block text-xs font-medium text-slate-600 dark:text-slate-400">Parameters</label>
						<button
							type="button"
							onclick={addParam}
							class="flex items-center gap-1 text-xs text-violet-500 hover:text-violet-600 transition-colors"
						>
							<Icon name="lucide:plus" class="w-3 h-3" />
							Add param
						</button>
					</div>
					{#if params.length === 0}
						<p class="text-xs text-slate-400 italic">No parameters defined. Use auto-detect or add manually.</p>
					{:else}
						<div class="space-y-2">
							{#each params as param, i (i)}
								<div class="flex items-start gap-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
									<!-- Name -->
									<input
										type="text"
										value={param.name}
										oninput={(e) => updateParam(i, 'name', (e.target as HTMLInputElement).value)}
										required
										placeholder="param_name"
										class="w-32 px-2 py-1.5 text-xs font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500"
									/>
									<!-- Type -->
									<select
										value={param.type}
										onchange={(e) => updateParam(i, 'type', (e.target as HTMLSelectElement).value as SqlApiParamType)}
										class="px-2 py-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
									>
										<option value="string">string</option>
										<option value="number">number</option>
										<option value="boolean">boolean</option>
									</select>
									<!-- Description -->
									<input
										type="text"
										value={param.description}
										oninput={(e) => updateParam(i, 'description', (e.target as HTMLInputElement).value)}
										placeholder="Description"
										class="flex-1 px-2 py-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500"
									/>
									<!-- Default value -->
									<input
										type="text"
										value={param.defaultValue ?? ''}
										oninput={(e) => updateParam(i, 'defaultValue', (e.target as HTMLInputElement).value || undefined as unknown as string)}
										placeholder="Default"
										class="w-20 px-2 py-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500"
									/>
									<!-- Required toggle -->
									<label class="flex items-center gap-1 pt-1.5 text-xs text-slate-500 cursor-pointer shrink-0">
										<input
											type="checkbox"
											checked={param.required}
											onchange={(e) => updateParam(i, 'required', (e.target as HTMLInputElement).checked)}
											class="rounded accent-violet-600"
										/>
										Req
									</label>
									<!-- Remove -->
									<button
										type="button"
										onclick={() => removeParam(i)}
										class="pt-1 text-slate-400 hover:text-red-500 transition-colors shrink-0"
									>
										<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
									</button>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Access + Rate Limit + Cache grid -->
				<div class="grid grid-cols-3 gap-4">
					<!-- Visibility -->
					<div class="col-span-3 flex items-center gap-6 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
						<label class="flex items-center gap-2 cursor-pointer select-none">
							<input type="checkbox" bind:checked={isPublic} class="rounded accent-violet-600" />
							<span class="text-xs text-slate-700 dark:text-slate-300">
								<span class="font-medium">Public</span>
								<span class="text-slate-400 ml-1">— no API key required</span>
							</span>
						</label>
						{#if isEdit}
							<label class="flex items-center gap-2 cursor-pointer select-none">
								<input type="checkbox" bind:checked={enabled} class="rounded accent-violet-600" />
								<span class="text-xs text-slate-700 dark:text-slate-300 font-medium">Enabled</span>
							</label>
						{/if}
					</div>

					<!-- Rate limit requests -->
					<div>
						<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Rate limit (requests)</label>
						<input
							type="number"
							bind:value={rateLimitRequests}
							min={1}
							max={10000}
							class="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
						/>
					</div>
					<!-- Rate limit window -->
					<div>
						<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Window (seconds)</label>
						<input
							type="number"
							bind:value={rateLimitWindowSecs}
							min={1}
							max={86400}
							class="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
						/>
					</div>
					<!-- Cache TTL -->
					<div>
						<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
							Cache TTL (secs)
							<span class="text-slate-400 font-normal">0 = off</span>
						</label>
						<input
							type="number"
							bind:value={cacheTtlSecs}
							min={0}
							max={86400}
							class="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
						/>
					</div>
				</div>

				<!-- Footer buttons -->
				<div class="flex items-center justify-end gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
					<button
						type="button"
						onclick={closeForm}
						class="px-4 py-2 text-xs rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={isSaving}
						class="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white transition-colors"
					>
						{#if isSaving}
							<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
							</svg>
						{/if}
						{isEdit ? 'Save changes' : 'Create endpoint'}
					</button>
				</div>

			</form>
		</div>
	</div>
{/if}
