<script lang="ts">
	interface Props {
		size?: 'sm' | 'md';
	}

	const { size = 'sm' }: Props = $props();
</script>

<span
	class="inline-block px-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 italic select-none {size === 'md' ? 'text-xs' : 'text-[10px]'}"
	title="NULL"
>NULL</span>
