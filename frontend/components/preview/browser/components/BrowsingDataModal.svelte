<script lang="ts">
	/**
	 * What the preview browser remembers, and how to make it forget.
	 *
	 * The preview keeps a Chrome profile per project, so signing into a site in
	 * one tab signs you in across the others and stays that way after a
	 * restart. That is what makes it usable — and it is exactly why this exists:
	 * a store you cannot inspect or empty is a store you end up distrusting.
	 *
	 * Per site rather than per storage kind. "Sign me out of this app" is the
	 * decision people actually make; cookies, local storage and cache are an
	 * implementation detail of that decision, and splitting the button three
	 * ways would ask the user to know which one their login lives in.
	 *
	 * Both clears confirm in place, on the row that owns them. Signing out of a
	 * site is not undoable and a misplaced click is cheap to make, so the second
	 * click is the point — but a dialog on top of a dialog would be worse than
	 * the mistake it prevents.
	 */
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';

	interface SiteData {
		domain: string;
		origin: string;
		cookies: number;
		open: boolean;
	}

	let { isOpen = $bindable(false) }: { isOpen: boolean } = $props();

	let sites = $state<SiteData[]>([]);
	let isLoading = $state(false);
	/** Domain being cleared right now, or `*` for the whole profile. */
	let clearing = $state<string | null>(null);
	/** Domain awaiting confirmation, or `*` for the whole profile. */
	let confirming = $state<string | null>(null);

	async function load() {
		isLoading = true;
		try {
			const result = await ws.http('preview:browser-data-list', {}, 10000);
			sites = result.sites ?? [];
		} catch (error) {
			debug.error('preview', 'Could not read browsing data:', error);
			sites = [];
		} finally {
			isLoading = false;
		}
	}

	async function clearSite(site: SiteData) {
		clearing = site.domain;
		try {
			await ws.http('preview:browser-data-clear', { origin: site.origin }, 15000);
			addNotification({
				type: 'success',
				title: 'Site data cleared',
				message: `${site.domain} has been signed out of this preview.`
			});
			confirming = null;
			await load();
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Could not clear site data',
				message: error instanceof Error ? error.message : 'Unknown error'
			});
		} finally {
			clearing = null;
		}
	}

	async function clearEverything() {
		clearing = '*';
		try {
			await ws.http('preview:browser-data-clear', {}, 20000);
			addNotification({
				type: 'success',
				title: 'Browsing data cleared',
				message: 'Every site has been signed out of this project’s preview.'
			});
			confirming = null;
			await load();
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Could not clear browsing data',
				message: error instanceof Error ? error.message : 'Unknown error'
			});
		} finally {
			clearing = null;
		}
	}

	function describe(site: SiteData): string {
		const stored = site.cookies === 0 ? 'No cookies' : `${site.cookies} cookie${site.cookies === 1 ? '' : 's'}`;
		return site.open ? `${stored} · open in a tab` : stored;
	}

	function close() {
		isOpen = false;
		confirming = null;
	}
</script>

<Modal {isOpen} onClose={close} onOpened={load} title="Preview browsing data" size="md">
	<div class="space-y-4">
		<p class="text-sm text-slate-500 dark:text-slate-400">
			Preview tabs in this project share one browser profile, so a login is kept across tabs and
			restarts. Clearing a site signs it out everywhere in this project's preview.
		</p>

		{#if isLoading}
			<div class="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
				<Icon name="lucide:loader" class="h-4 w-4 animate-spin" />
				<span>Reading stored data…</span>
			</div>
		{:else}
			<!-- The whole-profile action sits above the list it applies to, so it
			     reads as "and everything below", not as a stray dialog button.
			     Offered even with nothing listed: a site that stored no cookie
			     leaves nothing for CDP to enumerate, so an empty list means "no
			     cookies", not "no data". -->
			<div class="flex min-h-7 items-center justify-between gap-3">
				{#if confirming === '*'}
					<p class="text-xs text-slate-500 dark:text-slate-400">
						Sign out of every site and reload the open preview tabs?
					</p>
					<div class="flex shrink-0 items-center gap-1">
						<button
							type="button"
							onclick={() => (confirming = null)}
							disabled={clearing !== null}
							class="rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800"
						>
							Cancel
						</button>
						<button
							type="button"
							onclick={clearEverything}
							disabled={clearing !== null}
							class="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40"
						>
							{clearing === '*' ? 'Clearing…' : 'Clear everything'}
						</button>
					</div>
				{:else}
					<p class="text-xs text-slate-400 dark:text-slate-500">
						{sites.length === 0 ? 'Nothing listed' : `${sites.length} site${sites.length === 1 ? '' : 's'}`}
					</p>
					<button
						type="button"
						onclick={() => (confirming = '*')}
						disabled={clearing !== null}
						class="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-40 dark:text-red-400"
					>
						Clear all sites
					</button>
				{/if}
			</div>

			{#if sites.length === 0}
				<div
					class="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 py-10 text-center dark:border-slate-700"
				>
					<Icon name="lucide:cookie" class="h-6 w-6 text-slate-300 dark:text-slate-600" />
					<p class="text-sm text-slate-500 dark:text-slate-400">
						No cookies stored for this project yet.
					</p>
				</div>
			{:else}
				<ul
					class="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700"
				>
					{#each sites as site (site.domain)}
						<li class="flex items-center gap-3 px-3 py-2.5">
							<Icon name="lucide:globe" class="h-4 w-4 shrink-0 text-slate-400" />

							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
									{site.domain}
								</p>
								<p class="text-xs text-slate-400 dark:text-slate-500">
									{confirming === site.domain ? 'Sign out of this site?' : describe(site)}
								</p>
							</div>

							{#if confirming === site.domain}
								<div class="flex shrink-0 items-center gap-1">
									<button
										type="button"
										onclick={() => (confirming = null)}
										disabled={clearing !== null}
										class="rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800"
									>
										Cancel
									</button>
									<button
										type="button"
										onclick={() => clearSite(site)}
										disabled={clearing !== null}
										class="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40"
									>
										{clearing === site.domain ? 'Clearing…' : 'Clear'}
									</button>
								</div>
							{:else}
								<button
									type="button"
									onclick={() => (confirming = site.domain)}
									disabled={clearing !== null}
									class="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-400"
								>
									Clear
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</Modal>
