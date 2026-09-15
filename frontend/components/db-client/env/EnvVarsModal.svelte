<script lang="ts">
	/**
	 * The connection, as variables a project can read.
	 *
	 * TWO QUESTIONS, in the order they are actually asked: what are these
	 * variables called, and where do they go. An earlier version laid out three
	 * selects, a checkbox, a variable list and a diff as one flat column, which
	 * asked the user to hold all of it at once to answer either.
	 *
	 * So naming sits ON the variables card — it is the thing it changes — and
	 * the file sits on the write card, next to a plain sentence saying what
	 * applying does. The diff is not a flourish: this edits someone's own
	 * configuration file, and showing the change first is the only version of
	 * that which is defensible.
	 *
	 * Secrets are masked and revealed per view, never per session: a panel that
	 * remembered "revealed" would eventually show a password on a shared screen.
	 * Copy always copies the REAL value, because a masked clipboard would make
	 * the whole feature pointless.
	 */
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ConfirmDestructive from '$frontend/components/common/overlay/ConfirmDestructive.svelte';
	import Checkbox from '../shared/Checkbox.svelte';
	import { dbEnvStore } from '$frontend/stores/features/db-client-env.svelte';
	import type { DbEnvExistingGroup, DbEnvVar } from '$shared/types/db-client';

	interface Props {
		isOpen: boolean;
		connectionId: string | null;
		/** The database in scope, which is the one the URL describes. */
		database?: string | null;
		onClose: () => void;
	}

	let { isOpen = $bindable(), connectionId, database = null, onClose }: Props = $props();

	let revealed = $state(false);
	let copied = $state<string | null>(null);
	let confirmTracked = $state(false);

	const envState = $derived(dbEnvStore.state);
	const plan = $derived(dbEnvStore.plan);
	const shapeInfo = $derived(dbEnvStore.shapeInfo);
	const result = $derived(dbEnvStore.result);
	const hasProject = $derived(Boolean(envState?.detection.projectId));
	const files = $derived(dbEnvStore.writableFiles);
	const existing = $derived(envState?.detection.existing ?? []);

	const changeCount = $derived((plan?.updated.length ?? 0) + (plan?.appended.length ?? 0));
	const canApply = $derived(
		Boolean(plan?.fileName) && !dbEnvStore.busy && changeCount > 0
	);
	/** The file already holds at least one of these values, so there is an undo. */
	const canUndo = $derived(Boolean(plan?.fileName) && (plan?.unchanged.length ?? 0) > 0);

	/** What applying does, as one sentence rather than two counters. */
	const summary = $derived.by(() => {
		if (!plan?.fileName) return null;
		const parts: string[] = [];
		if (plan.updated.length > 0) parts.push(`updates ${plan.updated.join(', ')}`);
		if (plan.appended.length > 0) parts.push(`adds ${plan.appended.join(', ')}`);

		if (parts.length === 0) {
			return `${plan.fileName} already holds ${plan.unchanged.join(', ')}.`;
		}
		if (!plan.fileExists) {
			return `Creates ${plan.fileName} with ${plan.appended.join(', ')}.`;
		}
		return `In ${plan.fileName}: ${parts.join(', ')}.`;
	});

	$effect(() => {
		if (!isOpen || !connectionId) return;
		revealed = false;
		copied = null;
		void dbEnvStore.open(connectionId, database ?? undefined);
	});

	function close(): void {
		dbEnvStore.close();
		onClose();
	}

	/** A credential inside a URL: scheme://user:HERE@host. */
	const URL_CREDENTIAL = /^([a-z][a-z0-9+.-]*:\/\/[^:/@]*:)([^@]*)(@)/i;

	/**
	 * The raw credential strings on screen, so masking can be precise.
	 *
	 * A URL contributes only its PASSWORD, not the whole string: masking the
	 * host and the database too would hide the parts a user reads to check they
	 * are looking at the right connection.
	 */
	const secrets = $derived(
		(plan?.vars ?? [])
			.filter((entry) => entry.isSecret && entry.value)
			.map((entry) => URL_CREDENTIAL.exec(entry.value)?.[2] ?? entry.value)
			.filter((value) => value.length > 0)
	);

	/**
	 * Hide the credentials and nothing else.
	 *
	 * The second pass catches credentials this panel did not render — the
	 * PREVIOUS password on a removed diff line is still the user's secret, and a
	 * preview that showed it back to them would be a worse leak than the one
	 * being replaced.
	 */
	function mask(text: string): string {
		if (revealed) return text;
		let out = text;
		for (const secret of secrets) out = out.split(secret).join('••••••••');
		return out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)([^@\s]*)(@)/gi, '$1••••••••$3');
	}

	function displayValue(entry: DbEnvVar): string {
		if (!entry.isSecret || revealed) return entry.value;
		return mask(entry.value);
	}

	async function copy(label: string, text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			copied = label;
			setTimeout(() => {
				if (copied === label) copied = null;
			}, 1500);
		} catch {
			// A denied clipboard is not worth an error banner: the value is on
			// screen and can be selected by hand.
		}
	}

	/** True when the form is currently writing exactly this group's names. */
	function isFollowing(group: DbEnvExistingGroup): boolean {
		const current = dbEnvStore.keyMap;
		if (!current || dbEnvStore.shape !== group.shape) return false;
		return Object.entries(group.keyMap).every(
			([role, key]) => current[role as keyof typeof current] === key
		);
	}

	function adopt(group: DbEnvExistingGroup): void {
		dbEnvStore.useNames({ shape: group.shape, prefix: group.prefix, keyMap: group.keyMap });
		const target = group.files.find((name) => files.includes(name));
		if (target) dbEnvStore.setFileName(target);
	}

	function apply(): void {
		if (plan?.fileTracked) {
			confirmTracked = true;
			return;
		}
		void dbEnvStore.apply(false);
	}
</script>

<Modal bind:isOpen onClose={close} title="Environment variables" size="lg" mobileFullscreen>
	{#if dbEnvStore.loading}
		<div class="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
			<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
			<span>Reading the project…</span>
		</div>
	{:else if dbEnvStore.error}
		<div class="px-3 py-2 rounded-lg text-sm bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300">
			{dbEnvStore.error}
		</div>
	{:else if envState}
		<div class="flex flex-col gap-3">
			<p class="text-xs text-slate-500 dark:text-slate-400">
				<span class="font-semibold text-slate-700 dark:text-slate-200">{envState.connectionName}</span>
				{#if envState.database}
					· {envState.database}
				{/if}
				{#if hasProject}
					· {envState.detection.projectName}
				{:else}
					· no project open, so these can only be copied
				{/if}
			</p>

			<!-- What the project already calls this. One click to keep using it,
			     which is the whole reason detection exists. -->
			{#if existing.length > 0}
				<div class="flex flex-wrap items-center gap-1.5">
					<span class="text-3xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
						Already here
					</span>
					{#each existing as group (group.shape + group.prefix + group.keys.join(','))}
						{@const active = isFollowing(group)}
						<button
							type="button"
							class="flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full border text-3xs font-mono transition-colors
								{active
									? 'border-violet-400 bg-violet-500/10 text-violet-700 dark:text-violet-300'
									: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-violet-400'}"
							title={group.isTemplateOnly ? 'Documented but not set' : `In ${group.files[0] ?? 'this project'}`}
							onclick={() => adopt(group)}
						>
							<Icon
								name={group.isTemplateOnly ? 'lucide:file-question-mark' : 'lucide:check'}
								class="w-3 h-3 shrink-0 opacity-60"
							/>
							{group.keys.slice(0, 2).join(', ')}{group.keys.length > 2 ? ` +${group.keys.length - 2}` : ''}
						</button>
					{/each}
				</div>
			{/if}

			<!-- Card 1: the variables, with the naming that decides them. -->
			<section class="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
				<div class="flex flex-wrap items-center gap-2 px-2.5 py-2 bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800">
					<!-- Two options, and both are about SHAPE. Naming a framework here
					     would be asserting what a project calls its database while its
					     files are right there saying so — that answer is the row of
					     detected names above, not a dropdown. -->
					<select
						class="h-7 pl-2 pr-6 rounded-md text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
						value={dbEnvStore.shape}
						onchange={(e) => dbEnvStore.setShape(e.currentTarget.value as 'url' | 'split')}
						aria-label="Variable shape"
					>
						{#each envState.shapes as entry (entry.id)}
							<option value={entry.id}>{entry.label}</option>
						{/each}
					</select>

					<input
						type="text"
						class="h-7 w-28 px-2 rounded-md text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
						value={dbEnvStore.prefix}
						oninput={(e) => dbEnvStore.setPrefix(e.currentTarget.value)}
						aria-label="Variable prefix"
						title={shapeInfo?.description ?? 'Prefix for every variable below'}
					/>

					<div class="flex-1"></div>

					{#if dbEnvStore.previewing}
						<Icon name="lucide:loader" class="w-3 h-3 animate-spin text-slate-400" />
					{/if}
					<button
						type="button"
						class="flex items-center gap-1 px-1.5 h-7 rounded-md text-3xs text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-700/60"
						onclick={() => (revealed = !revealed)}
					>
						<Icon name={revealed ? 'lucide:eye-off' : 'lucide:eye'} class="w-3 h-3" />
						{revealed ? 'Hide' : 'Reveal'}
					</button>
					{#if plan && plan.vars.length > 0}
						<button
							type="button"
							class="flex items-center gap-1 px-1.5 h-7 rounded-md text-3xs text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-700/60"
							onclick={() => copy('all', plan.text)}
						>
							<Icon name={copied === 'all' ? 'lucide:check' : 'lucide:copy'} class="w-3 h-3" />
							{copied === 'all' ? 'Copied' : 'Copy all'}
						</button>
					{/if}
				</div>

				{#if dbEnvStore.previewError}
					<p class="px-2.5 py-2 text-xs text-rose-700 dark:text-rose-300">
						{dbEnvStore.previewError}
					</p>
				{:else if plan}
					<div class="divide-y divide-slate-200 dark:divide-slate-800">
						{#each plan.vars as entry (entry.key)}
							<div class="group flex items-center gap-2 px-2.5 py-1.5">
								<span class="shrink-0 text-xs font-mono font-semibold text-violet-700 dark:text-violet-300">
									{entry.key}
								</span>
								<span class="flex-1 min-w-0 text-xs font-mono text-slate-600 dark:text-slate-300 truncate">
									{displayValue(entry)}
								</span>
								{#if entry.note}
									<span class="hidden sm:block shrink-0 text-3xs text-slate-400 truncate max-w-[10rem]">
										{entry.note}
									</span>
								{/if}
								<button
									type="button"
									class="shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 opacity-0 group-hover:opacity-100 transition-opacity"
									onclick={() => copy(entry.key, `${entry.key}=${entry.value}`)}
									aria-label="Copy {entry.key}"
									title="Copy this line"
								>
									<Icon name={copied === entry.key ? 'lucide:check' : 'lucide:copy'} class="w-3 h-3" />
								</button>
							</div>
						{/each}
					</div>
				{/if}

				{#if envState.hasAlternate}
					<button
						type="button"
						class="flex items-center gap-2 w-full px-2.5 py-1.5 border-t border-slate-200 dark:border-slate-800 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
						onclick={() => dbEnvStore.setIncludeAlternate(!dbEnvStore.includeAlternate)}
					>
						<Checkbox
							checked={dbEnvStore.includeAlternate}
							ariaLabel="Include the direct endpoint"
						/>
						<span class="text-xs text-slate-600 dark:text-slate-300">
							Also add the {envState.alternateLabel} URL — migrations cannot run through a pooler.
						</span>
					</button>
				{/if}
			</section>

			{#each plan?.warnings ?? [] as warning (warning)}
				<p class="flex items-start gap-1.5 text-3xs text-amber-700 dark:text-amber-300">
					<Icon name="lucide:triangle-alert" class="w-3 h-3 shrink-0 mt-0.5" />
					<span>{warning}</span>
				</p>
			{/each}

			<!-- Card 2: where it goes, and what that does to the file. -->
			{#if hasProject}
				<section class="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
					<div class="flex items-center gap-2 px-2.5 py-2 bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800">
						<span class="text-xs text-slate-500 dark:text-slate-400 shrink-0">Write to</span>
						<select
							class="h-7 pl-2 pr-6 rounded-md text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
							value={dbEnvStore.fileName}
							onchange={(e) => dbEnvStore.setFileName(e.currentTarget.value)}
							aria-label="Target file"
						>
							{#if dbEnvStore.fileName && !files.includes(dbEnvStore.fileName)}
								<option value={dbEnvStore.fileName}>{dbEnvStore.fileName} — new</option>
							{/if}
							{#each files as name (name)}
								<option value={name}>{name}</option>
							{/each}
							<option value="">nothing — copy only</option>
						</select>
						<span class="flex-1 min-w-0 text-3xs text-slate-500 dark:text-slate-400 truncate">
							{summary ?? 'Nothing will be written.'}
						</span>
					</div>

					{#if plan?.fileTracked}
						<p class="flex items-start gap-1.5 px-2.5 py-2 text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
							<Icon name="lucide:git-branch" class="w-3.5 h-3.5 shrink-0 mt-0.5" />
							<span>git tracks {plan.fileName}, so applying would commit a live password.</span>
						</p>
					{/if}

					{#if plan && plan.diff.length > 0}
						<pre class="max-h-48 overflow-auto p-2 text-3xs font-mono leading-relaxed">{#each plan.diff as line, index (index)}<span
									class="block truncate {line.kind === 'added'
										? 'text-emerald-700 dark:text-emerald-400'
										: line.kind === 'removed'
											? 'text-rose-700 dark:text-rose-400'
											: 'text-slate-400 dark:text-slate-500'}"
								>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} {mask(line.text)}</span>{/each}</pre>
					{/if}
				</section>
			{/if}

			{#if result}
				<p
					class="px-3 py-2 rounded-lg text-xs
						{result.status === 'written' || result.status === 'unchanged'
							? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
							: 'bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300'}"
				>
					{#if result.status === 'written'}
						Wrote {result.updated.length + result.appended.length} variable(s) into {result.fileName}.
					{:else if result.status === 'unchanged'}
						{result.fileName} already said exactly this.
					{:else}
						{result.detail}
					{/if}
				</p>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<div class="flex items-center gap-2">
			{#if canUndo}
				<Button
					variant="ghost"
					size="sm"
					disabled={dbEnvStore.busy}
					loading={dbEnvStore.removing}
					onclick={() => dbEnvStore.remove()}
				>
					Undo write
				</Button>
			{/if}
			<div class="flex-1"></div>
			<Button variant="outline" size="sm" onclick={close}>Close</Button>
			{#if hasProject}
				<Button
					variant="primary"
					size="sm"
					disabled={!canApply}
					loading={dbEnvStore.applying}
					onclick={apply}
				>
					{plan?.fileName ? `Apply to ${plan.fileName}` : 'Apply'}
				</Button>
			{/if}
		</div>
	{/snippet}
</Modal>

<ConfirmDestructive
	bind:isOpen={confirmTracked}
	title="Write into a file git tracks?"
	message={`git tracks ${plan?.fileName ?? 'this file'}, so committing it would put a live database password in your history.`}
	confirmText="Write anyway"
	onConfirm={() => {
		confirmTracked = false;
		void dbEnvStore.apply(true);
	}}
	onClose={() => (confirmTracked = false)}
/>
