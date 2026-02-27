<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from './Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isOpen: boolean;
		title?: string;
		message: string;
		type?: 'info' | 'success' | 'warning' | 'error';
		onClose: () => void;
		closable?: boolean;
	}

	let {
		isOpen = $bindable(),
		title = 'Alert',
		message,
		type = 'info',
		onClose,
		closable = true
	}: Props = $props();

	function getIcon(type: string): IconName {
		switch (type) {
			case 'success':
				return 'lucide:circle-check';
			case 'error':
				return 'lucide:circle-x';
			case 'warning':
				return 'lucide:triangle-alert';
			case 'info':
			default:
				return 'lucide:info';
		}
	}

	function getColorClasses(type: string) {
		switch (type) {
			case 'success':
				return {
					bg: 'bg-green-50 dark:bg-green-900/20',
					border: 'border-green-200 dark:border-green-800',
					icon: 'text-green-600 dark:text-green-400',
					text: 'text-green-900 dark:text-green-100'
				};
			case 'error':
				return {
					bg: 'bg-red-50 dark:bg-red-900/20',
					border: 'border-red-200 dark:border-red-800',
					icon: 'text-red-600 dark:text-red-400',
					text: 'text-red-900 dark:text-red-100'
				};
			case 'warning':
				return {
					bg: 'bg-amber-50 dark:bg-amber-900/20',
					border: 'border-amber-200 dark:border-amber-800',
					icon: 'text-amber-600 dark:text-amber-400',
					text: 'text-amber-900 dark:text-amber-100'
				};
			case 'info':
			default:
				return {
					bg: 'bg-violet-50 dark:bg-violet-900/20',
					border: 'border-violet-200 dark:border-violet-800',
					icon: 'text-violet-600 dark:text-violet-400',
					text: 'text-violet-900 dark:text-violet-100'
				};
		}
	}

	const colors = $derived(getColorClasses(type));

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && closable) {
			onClose();
		}
		if (event.key === 'Enter') {
			onClose();
		}
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget && closable) {
			onClose();
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

{#if isOpen}
	<div
		class="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4"
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="alert-title"
		aria-describedby="alert-message"
		tabindex="-1"
		onclick={handleBackdropClick}
		onkeydown={(e) => e.key === 'Escape' && closable && onClose()}
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
			<div class="flex items-start space-x-4">
				<div class="{colors.bg} {colors.border} rounded-xl p-3 border">
					<Icon name={getIcon(type)} class="w-6 h-6 {colors.icon}" />
				</div>
				
				<div class="flex-1 space-y-2">
					<h3 id="alert-title" class="text-lg font-semibold {colors.text}">
						{title}
					</h3>
					<p id="alert-message" class="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
						{message}
					</p>
				</div>
			</div>
			
			<div class="flex justify-end pt-2">
				<button
					onclick={onClose}
					class="px-6 py-2.5 bg-violet-600 dark:bg-violet-600 text-white rounded-lg hover:bg-violet-700 dark:hover:bg-violet-700 transition-all duration-200 font-semibold focus:outline-none"
				>
					OK
				</button>
			</div>
		</div>
	</div>
{/if}