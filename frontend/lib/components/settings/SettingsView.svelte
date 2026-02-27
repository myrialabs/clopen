<script lang="ts">
	import PageTemplate from '../common/PageTemplate.svelte';

	// Import modular components
	import ModelSettings from './model/ModelSettings.svelte';
	import AppearanceSettings from './appearance/AppearanceSettings.svelte';
	import UserSettings from './user/UserSettings.svelte';
	import NotificationSettings from './notifications/NotificationSettings.svelte';
	import GeneralSettings from './general/GeneralSettings.svelte';
</script>

<PageTemplate
	title="Settings"
	description="Application settings"
>
	<div class="flex-1 overflow-auto">
		<div class="space-y-6">

			<!-- Model Configuration -->
			<ModelSettings />

			<!-- Appearance Configuration -->
			<AppearanceSettings />

			<!-- User Settings -->
			<UserSettings />

			<!-- Notification Settings -->
			<NotificationSettings />

			<!-- General Settings -->
			<GeneralSettings />

		</div>
	</div>
</PageTemplate>
