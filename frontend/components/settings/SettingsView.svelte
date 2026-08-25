<script lang="ts">
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import PageTemplate from '../common/display/PageTemplate.svelte';

	// Import modular components
	import AssistantSettings from './model/AssistantSettings.svelte';
	import GitSettings from './model/GitSettings.svelte';
	import ArtifactsSettings from './model/ArtifactsSettings.svelte';
	import AppearanceSettings from './appearance/AppearanceSettings.svelte';
	import AccountSettings from './account/AccountSettings.svelte';
	import NotificationSettings from './notifications/NotificationSettings.svelte';
	import SecuritySettings from './security/SecuritySettings.svelte';
	import SystemSettings from './system/SystemSettings.svelte';
	import UserManagement from './admin/UserManagement.svelte';
	import InviteManagement from './admin/InviteManagement.svelte';
	import TunnelSettings from './tunnel/TunnelSettings.svelte';

	const isAdmin = $derived(authStore.isAdmin);
	const isNoAuth = $derived(authStore.isNoAuth);
</script>

<PageTemplate
	title="Settings"
	description="Application settings"
>
	<div class="flex-1 overflow-auto">
		<div class="space-y-6">

			<!-- AI Model (Assistant + Commit Message + Artifacts) -->
			<AssistantSettings />
			<GitSettings />
			<ArtifactsSettings />

			<!-- Appearance Configuration -->
			<AppearanceSettings />

			<!-- Notification Settings -->
			<NotificationSettings />

			<!-- Tunnel Settings (admin-only) -->
			{#if isAdmin}
				<TunnelSettings />
			{/if}

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
