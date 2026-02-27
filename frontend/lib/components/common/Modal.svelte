<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		title?: string;
		size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
		closable?: boolean;
		className?: string;
		children?: import('svelte').Snippet;
		header?: import('svelte').Snippet;
		footer?: import('svelte').Snippet;
		contentRef?: HTMLElement;
	}

	let {
		isOpen = $bindable(),
		onClose,
		title,
		size = 'md',
		closable = true,
		className = '',
		children,
		header,
		footer,
		contentRef = $bindable()
	}: Props = $props();

	let modalElement = $state<HTMLDivElement>();

	// Handle escape key
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && closable && isOpen) {
			onClose();
		}
	}

	// Handle backdrop click
	function handleBackdropClick(event: MouseEvent) {
		if (closable && event.target === modalElement) {
			onClose();
		}
	}

	// Size classes mapping
	const sizeClasses = {
		sm: 'max-w-[95vw] md:max-w-md',
		md: 'max-w-[95vw] md:max-w-lg',
		lg: 'max-w-[95vw] md:max-w-2xl',
		xl: 'max-w-[95vw] md:max-w-4xl',
		full: 'max-w-[95vw] md:max-w-[90vw] max-h-[90vh]'
	};

	// Auto-focus management
	onMount(() => {
		if (isOpen) {
			// Focus the modal when it opens
			const focusableElement = modalElement?.querySelector(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			) as HTMLElement;
			focusableElement?.focus();
		}
	});

	// Watch for isOpen changes to manage focus
	$effect(() => {
		if (isOpen) {
			// Prevent body scroll when modal is open
			document.body.style.overflow = 'hidden';

			// Focus management
			setTimeout(() => {
				const focusableElement = modalElement?.querySelector(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
				) as HTMLElement;
				focusableElement?.focus();
			}, 50);
		} else {
			// Restore body scroll when modal is closed
			document.body.style.overflow = '';
		}
	});
</script>

<!-- Keyboard event listener -->
<svelte:window on:keydown={handleKeydown} />

{#if isOpen}
	<!-- Modal backdrop -->
	<div
		bind:this={modalElement}
		class="fixed inset-0 z-[150] bg-black/60 dark:bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-2 md:p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby={title ? 'modal-title' : undefined}
		tabindex="-1"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
		in:fade={{ duration: 200, easing: cubicOut }}
		out:fade={{ duration: 150, easing: cubicOut }}
	>
		<!-- Modal content -->
		<div
			class="bg-white dark:bg-slate-900 rounded-lg md:rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl w-full {sizeClasses[
				size
			]} max-h-[95vh] md:max-h-[90vh] overflow-hidden flex flex-col {className}"
			role="document"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			tabindex="-1"
			in:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
		>
			{#if header || title || closable}
				<!-- Modal header -->
				<div class="border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
					{#if header}
						{@render header()}
					{:else}
						<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
							{#if title}
								<h2
									id="modal-title"
									class="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100"
								>
									{title}
								</h2>
							{/if}

							{#if closable}
								<button
									type="button"
									class="p-1.5 md:p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors"
									onclick={onClose}
									aria-label="Close modal"
								>
									<svg
										class="w-4 h-4 md:w-5 md:h-5"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M6 18L18 6M6 6l12 12"
										/>
									</svg>
								</button>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Modal body -->
			<div bind:this={contentRef} class="flex-1 overflow-y-auto p-4 md:p-6">
				{#if children}
					{@render children()}
				{/if}
			</div>

			<!-- Modal footer slot (optional) -->
			{#if footer}
				<div
					class="flex items-center justify-end gap-2 md:gap-3 p-4 md:p-6 border-t border-slate-200 dark:border-slate-800 flex-shrink-0"
				>
					{@render footer()}
				</div>
			{/if}
		</div>
	</div>
{/if}
