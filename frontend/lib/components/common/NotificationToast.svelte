<script lang="ts">
	import { onMount } from 'svelte';
	import { removeNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import type { ToastNotification } from '$shared/types/ui/notifications';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
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
				return 'bg-green-50 border-green-200 text-green-800 dark:bg-green-900 dark:border-green-800 dark:text-green-200';
			case 'error':
				return 'bg-red-50 border-red-200 text-red-800 dark:bg-red-900 dark:border-red-800 dark:text-red-200';
			case 'warning':
				return 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-900 dark:border-amber-800 dark:text-amber-200';
			case 'info':
				return 'bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200';
			default:
				return 'bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200';
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
	<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 {getColorClasses(notification.type)}">
		<div class="flex items-start space-x-3">
			<div class="flex-shrink-0">
				<Icon name={getIcon(notification.type)} class="w-5 h-5" />
			</div>

			<div class="flex-1 min-w-0">
				<div class="flex items-center justify-between">
					<h4 class="font-medium text-sm">
						{notification.title}
					</h4>
					<button
						onclick={handleDismiss}
						class="flex-shrink-0 ml-2 p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
						aria-label="Dismiss notification"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>

				<p class="text-sm opacity-90 mt-1">
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
								class="text-xs font-medium px-3 py-1 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-md transition-colors"
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
