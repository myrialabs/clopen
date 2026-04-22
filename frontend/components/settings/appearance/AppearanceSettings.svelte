<script lang="ts">
	import { themeStore, toggleDarkMode } from '$frontend/stores/ui/theme.svelte';
	import { settings, updateSettings, applyFontSize } from '$frontend/stores/features/settings.svelte';
	import Icon from '../../common/display/Icon.svelte';

	const FONT_SIZE_MIN = 8;
	const FONT_SIZE_MAX = 24;

	function handleFontSizeChange(e: Event) {
		const value = Number((e.target as HTMLInputElement).value);
		applyFontSize(value);
		updateSettings({ fontSize: value });
	}

	function fontSizePercent() {
		return ((settings.fontSize - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN)) * 100;
	}

	function setChatAppearance(value: 'classic' | 'compact') {
		updateSettings({ chatAppearance: value });
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Theme</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		Customize the look and feel of the application
	</p>

	<div class="flex flex-col gap-4">
		<!-- Theme Toggle -->
		<div
			class="flex items-center justify-between p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl transition-all duration-150 hover:border-violet-500/20"
		>
			<div class="flex items-center gap-3.5">
				<div
					class="flex items-center justify-center w-10 h-10 bg-violet-500/10 dark:bg-violet-500/15 rounded-lg text-violet-600 dark:text-violet-400"
				>
					<Icon name={themeStore.isDark ? 'lucide:moon' : 'lucide:sun'} class="w-5 h-5" />
				</div>
				<div class="flex flex-col gap-0.5">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Dark Mode</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">Toggle between dark and light themes</div>
				</div>
			</div>
			<label class="relative inline-block w-12 h-6.5 shrink-0">
				<input
					type="checkbox"
					checked={themeStore.isDark}
					onchange={toggleDarkMode}
					class="opacity-0 w-0 h-0"
				/>
				<span
					class="absolute cursor-pointer inset-0 bg-slate-600/40 rounded-3xl transition-all duration-200
					before:absolute before:content-[''] before:h-5 before:w-5 before:left-0.75 before:bottom-0.75 before:bg-white before:rounded-full before:transition-all before:duration-200
					{themeStore.isDark
						? 'bg-gradient-to-br from-violet-600 to-purple-600 before:translate-x-5.5'
						: ''}"
				></span>
			</label>
		</div>

		<!-- Font Size -->
		<div
			class="flex flex-col gap-3 p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl transition-all duration-150 hover:border-violet-500/20"
		>
			<div class="flex items-center gap-3.5">
				<div
					class="flex items-center justify-center w-10 h-10 bg-violet-500/10 dark:bg-violet-500/15 rounded-lg text-violet-600 dark:text-violet-400"
				>
					<Icon name="lucide:type" class="w-5 h-5" />
				</div>
				<div class="flex flex-col gap-0.5 flex-1">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Font Size</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">Adjust the base font size of the application</div>
				</div>
				<div class="text-sm font-semibold text-violet-600 dark:text-violet-400 shrink-0 w-10 text-right">
					{settings.fontSize}px
				</div>
			</div>

			<div class="flex items-center gap-2.5 px-0.5">
				<span class="text-xs text-slate-500 dark:text-slate-500 shrink-0">A</span>
				<div class="relative flex-1 h-1.5">
					<div class="absolute inset-0 bg-slate-300 dark:bg-slate-700 rounded-full"></div>
					<div
						class="absolute inset-y-0 left-0 bg-gradient-to-r from-violet-500 to-purple-500 rounded-full"
						style="width: {fontSizePercent()}%"
					></div>
					<input
						type="range"
						min={FONT_SIZE_MIN}
						max={FONT_SIZE_MAX}
						step="1"
						value={settings.fontSize}
						oninput={handleFontSizeChange}
						class="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
					/>
					<div
						class="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-violet-500 rounded-full shadow-sm pointer-events-none"
						style="left: calc({fontSizePercent()}% - {fontSizePercent() / 100 * 16}px)"
					></div>
				</div>
				<span class="text-base text-slate-500 dark:text-slate-500 shrink-0">A</span>
			</div>
		</div>

		<!-- Message Layout -->
		<div
			class="flex flex-col gap-3 p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl transition-all duration-150 hover:border-violet-500/20"
		>
			<div class="flex items-center gap-3.5">
				<div
					class="flex items-center justify-center w-10 h-10 bg-violet-500/10 dark:bg-violet-500/15 rounded-lg text-violet-600 dark:text-violet-400"
				>
					<Icon name="lucide:layout-list" class="w-5 h-5" />
				</div>
				<div class="flex flex-col gap-0.5 flex-1">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Message Layout</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">
						Choose how AI chat messages are displayed
					</div>
				</div>
			</div>

			<div class="grid grid-cols-2 gap-3">
				<button
					type="button"
					onclick={() => setChatAppearance('classic')}
					class="flex flex-col gap-2 p-3 rounded-lg border-2 transition-all duration-150 text-left {settings.chatAppearance === 'classic'
						? 'border-violet-500 bg-violet-500/5'
						: 'border-slate-200 dark:border-slate-700 hover:border-violet-500/40'}"
					aria-pressed={settings.chatAppearance === 'classic'}
				>
					<div class="flex flex-col gap-1 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 overflow-hidden h-15">
						<!-- Card 1: header strip + content -->
						<div class="border border-slate-200 dark:border-slate-700 rounded mx-1.5 mt-1.5 overflow-hidden">
							<div class="flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800">
								<div class="w-4 h-1 rounded-full bg-slate-300 dark:bg-slate-600"></div>
								<div class="flex-1"></div>
								<div class="w-2 h-1 rounded-full bg-slate-300 dark:bg-slate-600"></div>
							</div>
							<div class="px-1.5 py-0.5">
								<div class="w-full h-1 rounded-full bg-slate-200 dark:bg-slate-700"></div>
							</div>
						</div>
						<!-- Card 2 -->
						<div class="border border-slate-200 dark:border-slate-700 rounded mx-1.5 overflow-hidden">
							<div class="flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800">
								<div class="w-3 h-1 rounded-full bg-slate-300 dark:bg-slate-600"></div>
								<div class="flex-1"></div>
								<div class="w-2 h-1 rounded-full bg-slate-300 dark:bg-slate-600"></div>
							</div>
							<div class="px-1.5 py-0.5">
								<div class="w-3/4 h-1 rounded-full bg-slate-200 dark:bg-slate-700"></div>
							</div>
						</div>
					</div>
					<div class="flex items-center justify-between">
						<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">Classic</span>
						{#if settings.chatAppearance === 'classic'}
							<Icon name="lucide:circle-check" class="w-4 h-4 text-violet-500" />
						{/if}
					</div>
					<span class="text-xs text-slate-600 dark:text-slate-500">Cards with headers and content sections</span>
				</button>

				<button
					type="button"
					onclick={() => setChatAppearance('compact')}
					class="flex flex-col gap-2 p-3 rounded-lg border-2 transition-all duration-150 text-left {settings.chatAppearance === 'compact'
						? 'border-violet-500 bg-violet-500/5'
						: 'border-slate-200 dark:border-slate-700 hover:border-violet-500/40'}"
					aria-pressed={settings.chatAppearance === 'compact'}
				>
					<div class="flex flex-col gap-1.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-2 h-15 overflow-hidden">
						<div class="w-3/4 h-1 rounded-full bg-slate-200 dark:bg-slate-700"></div>
						<div class="w-full h-1 rounded-full bg-slate-200 dark:bg-slate-700"></div>
						<div class="w-2/3 h-1 rounded-full bg-slate-200 dark:bg-slate-700"></div>
						<div class="w-full h-1 rounded-full bg-slate-200 dark:bg-slate-700"></div>
					</div>
					<div class="flex items-center justify-between">
						<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">Compact</span>
						{#if settings.chatAppearance === 'compact'}
							<Icon name="lucide:circle-check" class="w-4 h-4 text-violet-500" />
						{/if}
					</div>
					<span class="text-xs text-slate-600 dark:text-slate-500">Dense lines, no borders or cards</span>
				</button>
			</div>
		</div>
	</div>
</div>
