<script lang="ts">
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import PageTemplate from '../common/display/PageTemplate.svelte';

	// Import modular components
	import ModelSettings from './model/ModelSettings.svelte';
	import AppearanceSettings from './appearance/AppearanceSettings.svelte';
	import AccountSettings from './account/AccountSettings.svelte';
	import NotificationSettings from './notifications/NotificationSettings.svelte';
	import SecuritySettings from './security/SecuritySettings.svelte';
	import SystemSettings from './system/SystemSettings.svelte';
	import UserManagement from './admin/UserManagement.svelte';
	import InviteManagement from './admin/InviteManagement.svelte';

	const isAdmin = $derived(authStore.isAdmin);
	const isNoAuth = $derived(authStore.isNoAuth);
</script>

<PageTemplate
	title="Settings"
	description="Application settings"
>
	<div class="flex-1 overflow-auto">
		<div class="space-y-6">

			<!-- AI Model (Assistant + Commit Message) -->
			<ModelSettings />

			<!-- Appearance Configuration -->
			<AppearanceSettings />

			<!-- Notification Settings -->
			<NotificationSettings />

			<!-- Account (hidden in no-auth mode) -->
			{#if !isNoAuth}
				<AccountSettings />
			{/if}

			<!-- Admin-only sections -->
			{#if isAdmin}
				<UserManagement />
				<InviteManagement />
				<SecuritySettings />
				<SystemSettings />
			{/if}

		</div>
	</div>
</PageTemplate>
