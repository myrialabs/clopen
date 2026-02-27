<script lang="ts">
	import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import { manageConversationContext } from '$frontend/lib/utils/context-manager';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	
	const tokenUsage = $derived.by(() => {
		const context = manageConversationContext(sessionState.messages);
		return context.tokenUsage;
	});
	
	const usageColor = $derived.by(() => {
		if (tokenUsage.percentage >= 90) return 'text-red-500';
		if (tokenUsage.percentage >= 80) return 'text-amber-500';
		if (tokenUsage.percentage >= 60) return 'text-yellow-500';
		return 'text-emerald-500';
	});
	
	const bgColor = $derived.by(() => {
		if (tokenUsage.percentage >= 90) return 'bg-red-500/20';
		if (tokenUsage.percentage >= 80) return 'bg-amber-500/20';
		if (tokenUsage.percentage >= 60) return 'bg-yellow-500/20';
		return 'bg-emerald-500/20';
	});
	
	const progressColor = $derived.by(() => {
		if (tokenUsage.percentage >= 90) return 'bg-red-500';
		if (tokenUsage.percentage >= 80) return 'bg-amber-500';
		if (tokenUsage.percentage >= 60) return 'bg-yellow-500';
		return 'bg-emerald-500';
	});
	
	const previousNearLimit = $state(false);
	
	// DISABLED - Token limit notifications
	/*
	$effect(() => {
		// Show notification when first approaching limit
		if (tokenUsage.nearLimit && !previousNearLimit) {
			addNotification({
				type: 'warning',
				title: 'Approaching token limit',
				message: 'Older messages will be automatically summarized to save space when the limit is reached.',
				duration: 8000
			});
		}
		previousNearLimit = tokenUsage.nearLimit;
	});
	*/
</script>

<div class="relative">
	<!-- Token Usage Display -->
	<div class="flex items-center gap-2 px-3 py-1.5 rounded-lg {bgColor}">
		<Icon 
			name="lucide:brain" 
			class="w-4 h-4 {usageColor}"
		/>
		<div class="flex flex-col">
			<div class="flex items-center gap-2">
				<span class="text-xs font-medium {usageColor}">
					{tokenUsage.percentage}%
				</span>
				<span class="text-xs text-slate-500 dark:text-slate-400">
					({tokenUsage.current.toLocaleString()} / {tokenUsage.max.toLocaleString()} tokens)
				</span>
			</div>
			<!-- Progress Bar -->
			<div class="w-32 h-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden mt-1">
				<div 
					class="{progressColor} h-full transition-all duration-300"
					style="width: {Math.min(tokenUsage.percentage, 100)}%"
				></div>
			</div>
		</div>
	</div>
</div>

