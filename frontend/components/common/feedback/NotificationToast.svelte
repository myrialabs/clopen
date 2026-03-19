<script lang="ts">
	import { onMount } from 'svelte';
	import { removeNotification } from '$frontend/stores/ui/notification.svelte';
	import type { ToastNotification } from '$shared/types/ui/notifications';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	const { notification }: { notification: ToastNotification } = $props();

	let isVisible = $state(false);

	onMount(() => {
		// Animate in
		requestAnimationFrame(() => {
			isVisible = true;
		});

		// Auto-dismiss after duration
		if (notification.duration && notification.duration > 0) {
			setTimeout(() => {
				handleDismiss();
			}, notification.duration);
		}
	});

	function handleDismiss() {
		isVisible = false;
		setTimeout(() => {
			removeNotification(notification.id);
		}, 300); // Wait for animation to complete
	}

	function getIcon(type: string): IconName {
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
				return 'lucide:info';
		}
	}

	function getColorClasses(type: string) {
		switch (type) {
			case 'success':
				return 'bg-green-50 border-green-300 text-green-900 dark:bg-green-950 dark:border-green-700 dark:text-green-100';
			case 'error':
				return 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950 dark:border-red-700 dark:text-red-100';
			case 'warning':
				return 'bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-950 dark:border-amber-700 dark:text-amber-100';
			case 'info':
				return 'bg-blue-50 border-blue-300 text-blue-900 dark:bg-slate-800 dark:border-slate-600 dark:text-slate-100';
			default:
				return 'bg-slate-50 border-slate-300 text-slate-900 dark:bg-slate-800 dark:border-slate-600 dark:text-slate-100';
		}
	}

	function getIconColorClass(type: string) {
		switch (type) {
			case 'success':
				return 'text-green-600 dark:text-green-400';
			case 'error':
				return 'text-red-600 dark:text-red-400';
			case 'warning':
				return 'text-amber-600 dark:text-amber-400';
			case 'info':
				return 'text-blue-600 dark:text-blue-400';
			default:
				return 'text-slate-600 dark:text-slate-400';
		}
	}
</script>

<div
	class="transform transition-all duration-300 ease-out will-change-transform max-w-sm {isVisible
		? 'translate-x-0 opacity-100 scale-100'
		: 'translate-x-full opacity-0 scale-95'}"
	role="alert"
	aria-live="polite"
>
	<div class="border rounded-lg p-4 shadow-lg {getColorClasses(notification.type)}">
		<div class="flex items-start space-x-3">
			<div class="flex-shrink-0 {getIconColorClass(notification.type)}">
				<Icon name={getIcon(notification.type)} class="w-5 h-5" />
			</div>

			<div class="flex-1 min-w-0">
				<div class="flex items-center justify-between">
					<h4 class="font-semibold text-sm">
						{notification.title}
					</h4>
					<button
						onclick={handleDismiss}
						class="flex flex-shrink-0 ml-2 p-1 rounded opacity-60 hover:opacity-100 transition-opacity"
						aria-label="Dismiss notification"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>

				<p class="text-sm opacity-80 mt-1">
					{notification.message}
				</p>

				{#if notification.actions && notification.actions.length > 0}
					<div class="flex space-x-2 mt-3">
						{#each notification.actions as action (action.label)}
							<button
								onclick={() => {
									action.action();
									handleDismiss();
								}}
								class="text-xs font-medium px-3 py-1 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 rounded-md transition-colors"
							>
								{action.label}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
