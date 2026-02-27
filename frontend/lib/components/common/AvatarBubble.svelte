<script lang="ts">
	import { formatUserDisplayName } from '$shared/utils/anonymous-user';
	import type { AnonymousUser } from '$shared/utils/anonymous-user';
	
	interface Props {
		user: { userId: string; userName: string };
		size?: 'sm' | 'md' | 'lg';
		showName?: boolean;
	}
	
	const { user, size = 'sm', showName = false }: Props = $props();
	
	// Get avatar color and initials from user name
	function generateColorFromString(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			hash = str.charCodeAt(i) + ((hash << 5) - hash);
		}
		
		const hue = hash % 360;
		return `hsl(${hue}, 70%, 50%)`;
	}
	
	function getInitials(name: string): string {
		return name.substring(0, 2).toUpperCase();
	}
	
	// Size configurations
	const sizeClasses = {
		sm: 'w-6 h-6 text-xs',
		md: 'w-8 h-8 text-sm', 
		lg: 'w-10 h-10 text-base'
	} as const;
	
	const avatarColor = $derived(generateColorFromString(user.userName));
	const initials = $derived(getInitials(user.userName));
	const sizeClass = $derived(sizeClasses[size]);
</script>

<div class="flex items-center gap-2">
	<div class="relative">
		<div
			class="rounded-full flex items-center justify-center text-white font-bold border-2 border-white dark:border-slate-800 shadow-sm {sizeClass}"
			style="background-color: {avatarColor}"
			title={user.userName}
		>
			{initials}
		</div>
	</div>

	{#if showName}
		<span class="text-xs text-slate-600 dark:text-slate-400 font-medium">
			{user.userName}
		</span>
	{/if}
</div>