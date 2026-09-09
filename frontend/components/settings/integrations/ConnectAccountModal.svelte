<script lang="ts">
	/**
	 * Connect a provider, or rotate an existing account's credentials.
	 *
	 * The same dialog serves both, because they ask the same question. On an
	 * existing account a configured field renders as "Set — leave blank to keep",
	 * so the value is never sent back to the client and leaving it alone is the
	 * default rather than a footgun.
	 *
	 * This dialog is opened from the hub AND, later, from the surfaces that offer
	 * their own connect entry points. A user already in DB Client must never be
	 * told to go to Settings first.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import type { IntegrationAccountInfo, IntegrationCapability, IntegrationProviderInfo } from '$shared/types/integrations';
	import { CAPABILITY_LABELS } from './capabilities';

	interface Props {
		/** Null while closed. The component stays mounted either way — see below. */
		provider: IntegrationProviderInfo | null;
		/** Present when reconfiguring rather than connecting. */
		account?: IntegrationAccountInfo | null;
		onClose: () => void;
		onConnected?: (account: IntegrationAccountInfo) => void;
	}

	const { provider, account = null, onClose, onConnected }: Props = $props();

	// Mounted permanently, opened by flipping `isOpen`.
	//
	// Mounting the component only while open looks equivalent and is not: the
	// modal's `{#if isOpen}` is then already true when the block is first
	// created, so its intro transition never runs and the dialog appears without
	// animating — which is exactly what opening Connect from inside the Add
	// dialog looked like.
	//
	// Staying mounted means the field map is seeded by an `$effect`, i.e. AFTER
	// the first render, so the credential inputs must not use `bind:` — binding
	// to a key that does not exist yet is `props_invalid_value`. They read
	// through a `?? ''` and write back through `onchange` instead.
	let label = $state('');
	let values = $state<Record<string, string>>({});
	let capabilities = $state<IntegrationCapability[]>([]);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const isEditing = $derived(account !== null);

	// Re-seed whenever a different provider or account is opened.
	$effect(() => {
		const p = provider;
		if (!p) return;
		label = account?.label ?? '';
		values = Object.fromEntries(p.credentialFields.map(field => [field.name, '']));
		capabilities = account ? [...account.capabilities] : [...p.defaultCapabilities];
		error = null;
	});

	function setValue(field: string, value: string): void {
		values = { ...values, [field]: value };
	}

	function isConfigured(fieldName: string): boolean {
		return !!account?.configuredFields.includes(fieldName);
	}

	function toggleCapability(capability: IntegrationCapability) {
		capabilities = capabilities.includes(capability)
			? capabilities.filter(c => c !== capability)
			: [...capabilities, capability];
	}

	/** A required field is satisfied by a typed value, or by one already stored. */
	const missing = $derived(
		(provider?.credentialFields ?? [])
			.filter(field => field.isRequired && !(values[field.name] ?? '').trim() && !isConfigured(field.name))
			.map(field => field.label)
	);

	async function submit() {
		const p = provider;
		if (!p) return;
		if (missing.length > 0) {
			error = `Required: ${missing.join(', ')}`;
			return;
		}
		saving = true;
		error = null;
		try {
			if (account) {
				// An empty value means "not re-typed", so only send what changed.
				const changed = Object.fromEntries(
					Object.entries(values).filter(([, value]) => value.trim().length > 0)
				);
				await integrationsStore.update({
					id: account.id,
					credentials: Object.keys(changed).length > 0 ? changed : undefined,
					capabilities
				});
				onClose();
			} else {
				const connected = await integrationsStore.connect({
					provider: p.id,
					label: label.trim() || undefined,
					credentials: values,
					capabilities
				});
				onConnected?.(connected);
				onClose();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not connect';
		} finally {
			saving = false;
		}
	}
</script>

<Modal
	isOpen={provider !== null}
	onClose={onClose}
	title={isEditing ? `Reconfigure ${provider?.name ?? ''}` : `Connect ${provider?.name ?? ''}`}
	size="md"
>
	{#snippet children()}
		{#if provider}
			<div class="space-y-5 text-sm">
				<p class="text-xs text-slate-500 dark:text-slate-400">{provider.description}</p>

				<Input
					label="Name"
					type="text"
					placeholder={provider.name}
					disabled={isEditing}
					bind:value={label}
				/>
				{#if !isEditing}
					<p class="-mt-4 text-[11px] text-slate-400">
						Only needed if you connect more than one {provider.name} account.
					</p>
				{/if}

				<div class="space-y-3">
					{#each provider.credentialFields as field (field.name)}
						<div class="space-y-1">
							<Input
								label={field.label}
								required={field.isRequired && !isConfigured(field.name)}
								type={field.isSecret ? 'password' : 'text'}
								placeholder={isConfigured(field.name) ? '••••••••  leave blank to keep' : (field.placeholder ?? '')}
								value={values[field.name] ?? ''}
								onchange={(next) => setValue(field.name, next)}
							/>
							{#if field.help}
								<p class="text-[11px] text-slate-400">{field.help}</p>
							{/if}
						</div>
					{/each}
				</div>

				{#if provider.capabilities.length > 1}
					<div class="space-y-2">
						<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Use this account for</p>
						<div class="flex flex-wrap gap-1.5">
							{#each provider.capabilities as capability (capability)}
								{@const on = capabilities.includes(capability)}
								<button
									type="button"
									onclick={() => toggleCapability(capability)}
									class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border transition-colors
										{on
											? 'bg-violet-500/10 border-violet-500/30 text-violet-600 dark:text-violet-400'
											: 'bg-transparent border-slate-200 dark:border-slate-700 text-slate-400'}"
								>
									{#if on}<Icon name="lucide:check" class="w-3 h-3" />{/if}
									{CAPABILITY_LABELS[capability]}
								</button>
							{/each}
						</div>
					</div>
				{/if}

				<div class="flex items-start gap-2 p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
					<Icon name="lucide:lock" class="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
					<span class="text-[11px] text-slate-500 dark:text-slate-400">
						Stored encrypted in Clopen's database. That protects a database file that
						leaves this machine — a backup or a snapshot — not someone who can already
						read this machine's data directory.
					</span>
				</div>

				{#if provider.docsUrl}
					<a
						href={provider.docsUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1 text-xs font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400"
					>
						<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
						{provider.name} documentation
					</a>
				{/if}

				{#if error}
					<p class="text-xs text-red-500 break-words">{error}</p>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={onClose}>Cancel</Button>
		<Button variant="primary" loading={saving} disabled={missing.length > 0} onclick={submit}>
			{isEditing ? 'Save' : 'Connect'}
		</Button>
	{/snippet}
</Modal>
