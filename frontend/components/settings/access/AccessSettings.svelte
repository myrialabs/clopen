<script lang="ts">
	import { systemSettings } from '$frontend/stores/features/settings.svelte';
	import AuthModeSettings from '../general/AuthModeSettings.svelte';
	import AccessTokenSettings from './AccessTokenSettings.svelte';
	import SignedInDevicesSettings from './SignedInDevicesSettings.svelte';

	const isNoAuth = $derived(systemSettings.authMode === 'none');
</script>

<AuthModeSettings />

{#if !isNoAuth}
	<div class="mt-6">
		<AccessTokenSettings />
	</div>
{/if}

<div class="mt-6">
	<SignedInDevicesSettings />
</div>
