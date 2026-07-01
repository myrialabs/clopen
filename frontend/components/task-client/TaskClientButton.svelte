<script lang="ts">
  import Icon from '$frontend/components/common/display/Icon.svelte';
  interface Props {
    collapsed?: boolean;
    mobile?: boolean;
    onClick: () => void;
  }
  const { collapsed = false, mobile = false, onClick }: Props = $props();
</script>

{#if collapsed}
  <button
    type="button"
    class="flex items-center justify-center bg-transparent border-none text-slate-500 cursor-pointer transition-all duration-150 relative {mobile ? 'w-9 h-8 rounded-md active:bg-violet-500/10' : 'w-9 h-9 rounded-lg hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}"
    onclick={onClick}
    aria-label="Task Client"
    title="Task Client"
  >
    <Icon name="lucide:list-check" class="w-5 h-5" />
  </button>
{:else}
  <button
    type="button"
    class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none rounded-lg text-slate-500 text-sm cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
    onclick={onClick}
  >
    <div class="relative">
      <Icon name="lucide:list-check" class="w-4 h-4" />
    </div>
    <span class="flex-1 text-left">Task Client</span>
  </button>
{/if}
