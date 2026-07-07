<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { ARCHIVE_FORMATS, type ArchiveFormat, type ZipMethod } from '$frontend/utils/archive';

	interface CompressOptions {
		format: ArchiveFormat;
		method?: ZipMethod;
		level?: number;
		password?: string;
	}

	interface Props {
		isOpen: boolean;
		itemCount: number;
		onConfirm: (options: CompressOptions) => void;
		onClose: () => void;
	}

	const { isOpen, itemCount, onConfirm, onClose }: Props = $props();

	let format = $state<ArchiveFormat>('zip');
	let method = $state<ZipMethod>('deflate');
	let compression = $state<'default' | 'fastest' | 'smallest'>('default');
	let password = $state('');

	const activeFormat = $derived(ARCHIVE_FORMATS.find((f) => f.value === format) ?? ARCHIVE_FORMATS[0]);
	const isZip = $derived(format === 'zip');
	const supportsPassword = $derived(activeFormat.encryptable);

	// Reset every field each time the dialog opens so a previous run's choices
	// (format, method, password) never carry over.
	$effect(() => {
		if (isOpen) {
			format = 'zip';
			method = 'deflate';
			compression = 'default';
			password = '';
		}
	});

	// Clear ZIP-only fields when switching to a format that doesn't use them.
	$effect(() => {
		if (!isZip) {
			method = 'deflate';
			password = '';
		}
	});

	/** Map the friendly compression choice to a codec level for the chosen path. */
	function resolveLevel(): number | undefined {
		if (compression === 'default') return undefined;
		if (compression === 'fastest') return 1;
		// smallest
		if (format === 'tar.zst') return 19;
		if (isZip && method === 'zstd') return 19;
		return 9;
	}

	function confirm() {
		const options: CompressOptions = { format };
		if (isZip) {
			options.method = method;
			if (password.trim()) options.password = password;
		}
		const level = resolveLevel();
		if (level !== undefined) options.level = level;
		onConfirm(options);
	}
</script>

<Modal {isOpen} {onClose} title="Compress" size="sm">
	<div class="space-y-4 text-sm">
		<p class="text-slate-500 dark:text-slate-400">
			Compressing {itemCount === 1 ? '1 item' : `${itemCount} items`} into a single archive.
		</p>

		<div class="space-y-1.5">
			<span class="block text-xs font-medium text-slate-600 dark:text-slate-400">Format</span>
			<div class="grid grid-cols-3 gap-1.5">
				{#each ARCHIVE_FORMATS as f (f.value)}
					<button
						type="button"
						class="px-2 py-1.5 rounded-md border text-xs font-medium transition-colors {format === f.value
							? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300'
							: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}"
						onclick={() => (format = f.value)}
					>
						{f.label}
					</button>
				{/each}
			</div>
		</div>

		{#if isZip}
			<label class="block space-y-1.5">
				<span class="block text-xs font-medium text-slate-600 dark:text-slate-400">Method</span>
				<select
					bind:value={method}
					class="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
				>
					<option value="deflate">Deflate — universal</option>
					<option value="zstd">Zstd — denser, less compatible</option>
					<option value="store">Store — no compression</option>
				</select>
			</label>
		{/if}

		<label class="block space-y-1.5">
			<span class="block text-xs font-medium text-slate-600 dark:text-slate-400">Compression</span>
			<select
				bind:value={compression}
				disabled={isZip && method === 'store'}
				class="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 disabled:opacity-50"
			>
				<option value="default">Default</option>
				<option value="fastest">Fastest</option>
				<option value="smallest">Smallest</option>
			</select>
		</label>

		{#if supportsPassword}
			<label class="block space-y-1.5">
				<span class="block text-xs font-medium text-slate-600 dark:text-slate-400">Password <span class="text-slate-400">(optional, AES-256)</span></span>
				<input
					type="password"
					bind:value={password}
					autocomplete="new-password"
					placeholder="Leave empty for no encryption"
					class="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
				/>
			</label>
		{/if}
	</div>

	{#snippet footer()}
		<button
			type="button"
			class="px-3 py-1.5 rounded-md text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
			onclick={onClose}
		>
			Cancel
		</button>
		<button
			type="button"
			class="px-3 py-1.5 rounded-md text-sm font-medium bg-violet-600 hover:bg-violet-500 text-white"
			onclick={confirm}
		>
			Compress{activeFormat.extension}
		</button>
	{/snippet}
</Modal>
