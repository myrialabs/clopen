<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	
	const { errorText }: { errorText: string } = $props();
	
	// Categorize error types and provide suggestions
	function getErrorInfo(text: string): { type: string; suggestion: string } {
		if (text.includes('max_turns') || text.includes('maximum number of conversation turns')) {
			return {
				type: 'Task Completion Limit',
				suggestion: 'Try breaking your request into smaller, more specific tasks.'
			};
		} else if (text.includes('timeout') || text.includes('timed out')) {
			return {
				type: 'Timeout Error',
				suggestion: 'The operation took too long. Try with a simpler request.'
			};
		} else if (text.includes('permission') || text.includes('denied')) {
			return {
				type: 'Permission Error',
				suggestion: 'Check file permissions and ensure you have access to the project directory.'
			};
		} else if (text.includes('API key') || text.includes('authentication')) {
			return {
				type: 'Authentication Error',
				suggestion: 'Please check your Anthropic API key configuration.'
			};
		} else if (text.includes('git-bash') || text.includes('Git')) {
			return {
				type: 'Git Configuration Error',
				suggestion: 'Ensure Git is installed and accessible in your system PATH.'
			};
		}
		
		return {
			type: 'Error',
			suggestion: ''
		};
	}
	
	const errorInfo = $derived(getErrorInfo(errorText));
</script>

<div class="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
	<div class="flex items-start gap-3">
		<Icon name="lucide:circle-alert" class="text-red-500 w-6 h-6 mt-0.5" />
		<div class="flex-1">
			<div class="font-bold text-red-700 dark:text-red-300 mb-2">{errorInfo.type}</div>
			<div class="text-sm text-red-600 dark:text-red-400 leading-relaxed">{errorText}</div>
			{#if errorInfo.suggestion}
				<div class="mt-3 text-xs text-red-500 dark:text-red-400 bg-red-100 dark:bg-red-900/30 p-2 rounded border-l-2 border-red-400">
					{errorInfo.suggestion}
				</div>
			{/if}
		</div>
	</div>
</div>