<script lang="ts">
	/**
	 * Migrations: what the database has, what the repository has, and the gap.
	 *
	 * The list is a UNION of two sources — versions recorded in
	 * `supabase_migrations.schema_migrations` and `.sql` files in
	 * `supabase/migrations` — because each on its own hides a different problem.
	 * Files alone cannot show that someone pushed from their laptop; the table
	 * alone cannot show what is waiting to go out.
	 *
	 * Applying is the one write in this surface, so it goes behind a confirm that
	 * names the host it is about to change rather than asking "are you sure".
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import ConfirmDestructive from '$frontend/components/common/overlay/ConfirmDestructive.svelte';
	import InlineError from '$frontend/components/common/display/InlineError.svelte';
	import MonacoCodeEditor from '$frontend/components/common/editor/MonacoCodeEditor.svelte';
	import { dbAccountsStore } from '$frontend/stores/features/db-client-accounts.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { showSuccess } from '$frontend/stores/ui/notification.svelte';
	import type { SupabaseMigration } from '$shared/types/db-client';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	let sqlOpen = $state(false);
	let sqlText = $state('');
	let sqlTitle = $state('');
	let confirmOpen = $state(false);
	let pendingVersion = $state<string | null>(null);
	let applying = $state(false);
	let applyError = $state<string | null>(null);

	const cell = $derived(dbAccountsStore.migrationsFor(connectionId));
	const report = $derived(cell.data);
	const connection = $derived(
		dbClientStore.connections.find((entry) => entry.id === connectionId) ?? null
	);

	const pending = $derived((report?.migrations ?? []).filter((entry) => !entry.isApplied));

	// The host is what a confirm has to name: "production" is a word, and a
	// hostname is the thing the user can recognise.
	const targetHost = $derived(connection?.host ?? 'this database');

	// Fire-once, and decided OUTSIDE the reactive graph — see the store. Reading
	// `cell` here would subscribe this effect to the very cell the fetch writes,
	// and on a failed fetch (data null, loading false) it would retry forever.
	$effect(() => {
		dbAccountsStore.ensureMigrations(connectionId);
	});

	function statusOf(migration: SupabaseMigration): { label: string; class: string } {
		if (!migration.isApplied) {
			return { label: 'Pending', class: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' };
		}
		if (!migration.path) {
			return { label: 'Remote only', class: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' };
		}
		return { label: 'Applied', class: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' };
	}

	async function viewSql(migration: SupabaseMigration): Promise<void> {
		try {
			sqlText = await dbAccountsStore.migrationSql(connectionId, migration.version);
			sqlTitle = `${migration.version}${migration.name ? ` — ${migration.name}` : ''}`;
			sqlOpen = true;
		} catch (error) {
			applyError = error instanceof Error ? error.message : 'Could not read that migration';
		}
	}

	function askApply(version: string): void {
		pendingVersion = version;
		confirmOpen = true;
	}

	async function apply(): Promise<void> {
		if (!pendingVersion) return;
		const version = pendingVersion;
		confirmOpen = false;
		applying = true;
		applyError = null;
		try {
			const result = await dbAccountsStore.applyMigration(connectionId, version);
			// An outcome the user only needs to KNOW goes to a toast; anything they
			// must ACT on stays in the panel, which is where `applyError` renders.
			showSuccess('Migration applied', `${result.version} · ${result.durationMs}ms`);
			// The schema just changed underneath the tree and every open table.
			dbClientStore.requestSchemaReload();
		} catch (error) {
			applyError = error instanceof Error ? error.message : 'Could not apply that migration';
		} finally {
			applying = false;
			pendingVersion = null;
		}
	}
</script>

<div class="flex flex-col gap-3 p-3">
	{#if cell.loading && !report}
		<div class="flex flex-col gap-1.5">
			{#each [0, 1, 2, 3] as row (row)}
				<div class="h-10 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
			{/each}
		</div>
	{:else if cell.error}
		<InlineError message={cell.error} />
	{:else if report}
		{#if !report.localDir}
			<p class="px-3 py-2 rounded-md text-xs bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400">
				No <code>supabase/migrations</code> in the open project, so only what the database already
				recorded is listed. Open the project this schema belongs to, or run <code>supabase init</code> in it.
			</p>
		{:else if report.hasRemoteOnly}
			<p class="px-3 py-2 rounded-md text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
				Some applied versions have no file here — they were pushed from somewhere else. Pull before
				you add another migration, or the two histories will diverge.
			</p>
		{/if}

		{#if applyError}
			<InlineError message={applyError} onDismiss={() => (applyError = null)} />
		{/if}

		{#if report.migrations.length === 0}
			<div class="flex flex-col items-center gap-2 py-10 text-center">
				<Icon name="lucide:layers" class="w-8 h-8 text-slate-300 dark:text-slate-600" />
				<p class="text-sm text-slate-500 dark:text-slate-400">No migrations yet.</p>
			</div>
		{:else}
			{#if pending.length > 0}
				<div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
					<span class="font-semibold text-amber-600 dark:text-amber-400">{pending.length} pending</span>
					<span>· applied in version order, oldest first</span>
				</div>
			{/if}

			<div class="flex flex-col gap-1">
				{#each report.migrations as migration (migration.version)}
					{@const status = statusOf(migration)}
					<div class="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 min-w-0">
						<span class="text-3xs px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider shrink-0 {status.class}">
							{status.label}
						</span>
						<div class="flex flex-col min-w-0 flex-1">
							<span class="text-sm text-slate-800 dark:text-slate-200 truncate">
								{migration.name ?? migration.version}
							</span>
							<span class="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
								{migration.version}{migration.size !== null ? ` · ${migration.size} B` : ''}
							</span>
						</div>
						<div class="flex items-center gap-1 shrink-0">
							{#if migration.path}
								<button
									type="button"
									class="px-2 h-7 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
									onclick={() => viewSql(migration)}
								>
									View SQL
								</button>
							{/if}
							{#if !migration.isApplied && migration.path}
								<button
									type="button"
									class="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-semibold bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
									disabled={applying}
									onclick={() => askApply(migration.version)}
								>
									{#if applying && pendingVersion === migration.version}
										<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
									{:else}
										<Icon name="lucide:play" class="w-3.5 h-3.5" />
									{/if}
									Apply
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<Modal bind:isOpen={sqlOpen} title={sqlTitle} size="xl" onClose={() => (sqlOpen = false)}>
	<div class="h-[60vh]">
		<MonacoCodeEditor value={sqlText} language="sql" readonly height="100%" />
	</div>
</Modal>

<ConfirmDestructive
	bind:isOpen={confirmOpen}
	title="Apply this migration?"
	message={`This runs ${pendingVersion} against ${targetHost} and records the version, exactly as \`supabase db push\` would. It runs in one transaction, so a failure leaves nothing behind — but a migration that succeeds is not undone by closing this dialog.`}
	confirmText="Apply migration"
	onConfirm={apply}
	onClose={() => {
		confirmOpen = false;
		pendingVersion = null;
	}}
/>
