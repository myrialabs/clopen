<script lang="ts">
	import DeviceSessionsList from '$frontend/components/remote-access/DeviceSessionsList.svelte';
	import Icon from '../../common/display/Icon.svelte';
	import { closeSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import { openRemoteAccessDialog } from '$frontend/stores/ui/quick-panels.svelte';

	function addDevice() {
		closeSettingsModal();
		openRemoteAccessDialog();
	}
</script>

<div class="py-1">
	<div class="flex items-start justify-between gap-3 mb-5">
		<div>
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Signed-in Devices</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500">
				Browsers signed in to Clopen.
			</p>
		</div>
		<button
			type="button"
			onclick={addDevice}
			class="inline-flex items-center gap-1.5 shrink-0 py-2 px-3.5 bg-violet-500/10 border border-violet-500/20 dark:border-violet-500/25 rounded-lg text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20"
		>
			<Icon name="lucide:smartphone" class="w-3.5 h-3.5" />
			Add a device
		</button>
	</div>

	<DeviceSessionsList />
</div>
