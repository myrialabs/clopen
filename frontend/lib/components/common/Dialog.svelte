<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from './Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		title?: string;
		type?: 'info' | 'warning' | 'error' | 'success';
		message?: string;
		inputValue?: string;
		inputPlaceholder?: string;
		confirmText?: string;
		cancelText?: string;
		showCancel?: boolean;
		closable?: boolean;
		confirmDisabled?: boolean;
		onConfirm?: (value?: string) => void;
		children?: import('svelte').Snippet;
	}

	let {
		isOpen = $bindable(),
		onClose,
		title = 'Dialog',
		type = 'info',
		message = '',
		inputValue = $bindable(),
		inputPlaceholder = 'Enter value...',
		confirmText = 'OK',
		cancelText = 'Cancel',
		showCancel = true,
		closable = true,
		confirmDisabled = false,
		onConfirm,
		children
	}: Props = $props();

	let inputElement = $state<HTMLInputElement>();
	let dialogElement = $state<HTMLDivElement>();

	function getIcon(type: string): IconName | null {
		switch (type) {
			case 'success':
				return 'lucide:circle-check';
			case 'error':
				return 'lucide:circle-x';
			case 'warning':
				return 'lucide:triangle-alert';
			case 'info':
				return 'lucide:info';
			default:
				return null;
		}
	}

	function getColorClasses(type: string) {
		switch (type) {
			case 'success':
				return {
					bg: 'bg-green-50 dark:bg-green-900/20',
					border: 'border-green-200 dark:border-green-700/50',
					icon: 'text-green-600 dark:text-green-400',
					text: 'text-green-900 dark:text-green-100',
					button: 'bg-green-600 dark:bg-green-600 hover:bg-green-700 dark:hover:bg-green-700 text-white',
					input: 'focus:border-green-400 dark:focus:border-green-500'
				};
			case 'error':
				return {
					bg: 'bg-red-50 dark:bg-red-900/20',
					border: 'border-red-200 dark:border-red-700/50',
					icon: 'text-red-600 dark:text-red-400',
					text: 'text-red-900 dark:text-red-100',
					button: 'bg-red-600 dark:bg-red-600 hover:bg-red-700 dark:hover:bg-red-700 text-white',
					input: 'focus:border-red-400 dark:focus:border-red-500'
				};
			case 'warning':
				return {
					bg: 'bg-amber-50 dark:bg-amber-900/20',
					border: 'border-amber-200 dark:border-amber-700/50',
					icon: 'text-amber-600 dark:text-amber-400',
					text: 'text-amber-900 dark:text-amber-100',
					button: 'bg-amber-600 dark:bg-amber-600 hover:bg-amber-700 dark:hover:bg-amber-700 text-white',
					input: 'focus:border-amber-400 dark:focus:border-amber-500'
				};
			case 'info':
			default:
				return {
					bg: 'bg-violet-50 dark:bg-violet-900/20',
					border: 'border-violet-200 dark:border-violet-700/50',
					icon: 'text-violet-600 dark:text-violet-400',
					text: 'text-slate-900 dark:text-slate-100',
					button: 'bg-violet-600 dark:bg-violet-600 hover:bg-violet-700 dark:hover:bg-violet-700 text-white',
					input: 'focus:border-violet-400 dark:focus:border-violet-500'
				};
		}
	}

	const colors = $derived(getColorClasses(type));
	const icon = $derived(getIcon(type));

	function handleKeydown(event: KeyboardEvent) {
		// Guard: only handle keyboard events when this dialog is open.
		// Without this, <svelte:window on:keydown> captures events globally,
		// causing ALL Dialog instances (e.g. per-message restore dialogs)
		// to fire handleConfirm on any Enter keypress — even from chat input.
		if (!isOpen) return;
		if (event.key === 'Escape' && closable) {
			handleCancel();
		} else if (event.key === 'Enter' && !confirmDisabled) {
			handleConfirm();
		}
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget && closable) {
			handleCancel();
		}
	}

	function handleConfirm() {
		if (onConfirm) {
			onConfirm(inputValue !== undefined ? inputValue : undefined);
		}
		onClose();
	}

	function handleCancel() {
		onClose();
	}

	// Auto-focus management
	onMount(() => {
		if (isOpen) {
			if (inputValue !== undefined && inputElement) {
				inputElement.focus();
				inputElement.select();
			} else {
				const focusableElement = dialogElement?.querySelector(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
				) as HTMLElement;
				focusableElement?.focus();
			}
		}
	});

	// Watch for isOpen changes
	$effect(() => {
		if (isOpen) {
			// Prevent body scroll when dialog is open
			document.body.style.overflow = 'hidden';
			
			// Focus management
			setTimeout(() => {
				if (inputValue !== undefined && inputElement) {
					inputElement.focus();
					inputElement.select();
				}
			}, 50);
		} else {
			// Restore body scroll when dialog is closed
			document.body.style.overflow = '';
		}
	});
</script>

<svelte:window on:keydown={handleKeydown} />

{#if isOpen}
	<div
		bind:this={dialogElement}
		class="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="dialog-title"
		aria-describedby="dialog-message"
		tabindex="-1"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
		in:fade={{ duration: 200, easing: cubicOut }}
		out:fade={{ duration: 150, easing: cubicOut }}
	>
		<div
			class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl max-w-md w-full p-6 space-y-4 shadow-xl"
			role="document"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			in:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
		>
			{#if children}
				{@render children()}
			{:else}
				<div class="flex items-start space-x-4">
					{#if icon}
						<div class="{colors.bg} {colors.border} rounded-xl p-3 border">
							<Icon name={icon} class="w-6 h-6 {colors.icon}" />
						</div>
					{/if}
					
					<div class="flex-1 space-y-2">
						<h3 id="dialog-title" class="text-lg font-semibold {colors.text}">
							{title}
						</h3>
						{#if message}
							<div id="dialog-message" class="text-sm text-slate-600 dark:text-slate-400 leading-relaxed space-y-2">
								{#each message.split('\n') as line}
									<p>{line || '\u00A0'}</p>
								{/each}
							</div>
						{/if}
						
						{#if inputValue !== undefined}
							<input
								bind:this={inputElement}
								bind:value={inputValue}
								type="text"
								placeholder={inputPlaceholder}
								onkeydown={handleKeydown}
								class="w-full px-4 py-2.5 mt-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder-slate-500 dark:placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/20 {colors.input}"
							/>
						{/if}
					</div>
				</div>
			{/if}
			
			<div class="flex justify-end gap-3 pt-2">
				{#if showCancel}
					<button
						onclick={handleCancel}
						class="px-6 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 font-semibold"
					>
						{cancelText}
					</button>
				{/if}
				<button
					onclick={handleConfirm}
					disabled={confirmDisabled}
					class="px-6 py-2.5 {colors.button} rounded-lg transition-all duration-200 font-semibold focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-current"
				>
					{confirmText}
				</button>
			</div>
		</div>
	</div>
{/if}