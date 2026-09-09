<script lang="ts">
	/**
	 * The credential form shared by Install, Configure and Add-manually.
	 *
	 * Fields are grouped by where their value lands — environment variables for a
	 * local server, headers for a remote one — rather than by required/optional,
	 * because that grouping is the thing a user has to get right. Required is a
	 * per-field "*" within each group.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import type { McpConfigField } from '$frontend/stores/features/mcp-servers.svelte';
	import type { McpConfigDraft, CustomRow } from './mcp-config-draft.svelte';

	interface Props {
		draft: McpConfigDraft;
		/** Whether the stdio command and args are editable here. */
		allowCommandEdit?: boolean;
	}

	const { draft, allowCommandEdit = true }: Props = $props();
</script>

{#snippet fieldInput(field: McpConfigField)}
	<div class="space-y-1">
		<Input
			label={field.name}
			required={field.isRequired}
			type="text"
			value={draft.values[field.name] ?? ''}
			onchange={(next) => draft.setValue(field.name, next)}
		/>
		{#if field.description}
			<p class="text-[11px] text-slate-400">{field.description}</p>
		{/if}
	</div>
{/snippet}

{#snippet customList(
	rows: CustomRow[],
	keyPlaceholder: string,
	addLabel: string,
	onAdd: () => void,
	onRemove: (index: number) => void
)}
	{#each rows as row, i (i)}
		<div class="flex gap-2 items-center">
			<div class="w-2/5">
				<Input bind:value={row.key} placeholder={keyPlaceholder} />
			</div>
			<div class="flex-1">
				<Input type="text" bind:value={row.value} placeholder="value" />
			</div>
			<button
				type="button"
				onclick={() => onRemove(i)}
				class="flex p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
				aria-label="Remove field"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	{/each}
	<Button variant="ghost" size="sm" onclick={onAdd}>{addLabel}</Button>
{/snippet}

<div class="space-y-5">
	{#if allowCommandEdit && draft.transport === 'stdio'}
		<div class="space-y-3">
			<div class="space-y-1">
				<Input label="Command" type="text" placeholder="npx" bind:value={draft.command} />
			</div>
			<div class="space-y-1">
				<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Arguments</p>
				<textarea
					bind:value={draft.argsText}
					rows="3"
					placeholder={'-y\nxcodebuildmcp\nmcp'}
					class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y"
				></textarea>
				<p class="text-[11px] text-slate-400">One argument per line, in order.</p>
			</div>
			<div class="border-t border-slate-300 dark:border-slate-600"></div>
		</div>
	{/if}

	{#if draft.showEnvSection}
		<div class="space-y-5">
			{#if draft.envFields.length > 0}
				<div class="space-y-2">
					<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Environment variables</p>
					{#each draft.envFields as field (field.name)}
						{@render fieldInput(field)}
					{/each}
				</div>
				<div class="border-t border-slate-300 dark:border-slate-600"></div>
			{/if}
			<div class="space-y-2">
				<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Custom variables</p>
				{@render customList(
					draft.customEnv,
					'VAR_NAME',
					'+ Add variable',
					() => draft.addCustomEnv(),
					(i) => draft.removeCustomEnv(i)
				)}
			</div>
		</div>
	{/if}

	{#if draft.showHeaderSection}
		<div class="space-y-3">
			{#if draft.headerFields.length > 0}
				<div class="space-y-2">
					<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Headers</p>
					{#each draft.headerFields as field (field.name)}
						{@render fieldInput(field)}
					{/each}
				</div>
			{/if}
			<div class="space-y-2">
				<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Custom headers</p>
				{@render customList(
					draft.customHeader,
					'Header',
					'+ Add header',
					() => draft.addCustomHeader(),
					(i) => draft.removeCustomHeader(i)
				)}
			</div>
		</div>
	{/if}
</div>
