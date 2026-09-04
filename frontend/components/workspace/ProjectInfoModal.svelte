<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import type { Project } from '$shared/types/database/schema';
	import ws from '$frontend/utils/ws';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		project: Project | null;
	}

	let { isOpen = $bindable(), onClose, project }: Props = $props();

	interface InfoData {
		project: Project;
		storage: {
			sizeBytes: number;
			fileCount: number;
			dirCount: number;
			truncated: boolean;
			error?: string;
		};
		resources: {
			status: 'running' | 'not_running';
			/** null when the host process table could not be read — not zero. */
			cpuPercent: number | null;
			memRssBytes: number | null;
			memPercent: number | null;
			processCount: number;
			rootPids: number[];
			processes: Array<{
				pid: number;
				parentPid: number;
				name: string;
				cpuPercent: number | null;
				memRssBytes: number;
				command: string;
			}>;
		};
		meta: {
			platform: string;
			arch: string;
			logicalCores: number;
		};
	}

	const POLL_INTERVAL_MS = 3000;

	let data = $state<InfoData | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let copied = $state(false);

	function formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const k = 1024;
		const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
		const size = bytes / Math.pow(k, i);
		return `${size >= 100 ? Math.round(size) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[i]}`;
	}

	function formatPercent(value: number | null): string {
		return value === null ? '—' : `${value.toFixed(1)}%`;
	}

	/**
	 * One poll at a time, chained after the previous answer instead of fired on a
	 * fixed interval: the probe walks a folder and reads the host process table,
	 * which on a large project or a Windows host outruns the interval and would
	 * otherwise queue requests faster than the server answers them.
	 *
	 * `token` drops the answer to a request whose project is no longer the one on
	 * screen, so switching projects quickly cannot paint stale numbers.
	 */
	let token = 0;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	async function fetchInfo(projectId: string, requestToken: number, reschedule: boolean) {
		try {
			const result = (await ws.http('projects:info', { id: projectId })) as InfoData;
			if (requestToken !== token) return;
			data = result;
			error = null;
		} catch (e) {
			if (requestToken !== token) return;
			error = e instanceof Error ? e.message : String(e);
		} finally {
			if (requestToken === token) {
				loading = false;
				if (reschedule) {
					pollTimer = setTimeout(() => void fetchInfo(projectId, requestToken, true), POLL_INTERVAL_MS);
				}
			}
		}
	}

	$effect(() => {
		const projectId = isOpen ? project?.id : undefined;

		token++;
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;

		if (!projectId) {
			data = null;
			error = null;
			loading = false;
			return;
		}

		const requestToken = token;
		loading = true;
		data = null;
		error = null;
		void fetchInfo(projectId, requestToken, true);

		return () => {
			token++;
			if (pollTimer) clearTimeout(pollTimer);
			pollTimer = null;
		};
	});

	/**
	 * `navigator.clipboard` only exists on a secure origin, and Clopen is
	 * routinely reached over plain HTTP on a LAN address, so the async API cannot
	 * be the only path — without the fallback the button throws and does nothing.
	 */
	async function copyPath() {
		const path = project?.path;
		if (!path) return;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(path);
			} else {
				const field = document.createElement('textarea');
				field.value = path;
				field.setAttribute('readonly', '');
				field.style.position = 'fixed';
				field.style.opacity = '0';
				document.body.appendChild(field);
				field.select();
				document.execCommand('copy');
				field.remove();
			}
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard denied by the browser — leave the icon unchanged.
		}
	}
</script>

<Modal bind:isOpen {onClose} size="lg" title="Project Info">
	{#snippet children()}
		{#if !project}
			<div class="flex items-center justify-center py-12 text-sm text-slate-500">No project selected</div>
		{:else if loading && !data}
			<div class="flex flex-col items-center justify-center py-12 gap-3">
				<Icon name="lucide:loader-circle" class="w-6 h-6 animate-spin text-violet-500" />
				<span class="text-sm text-slate-500 dark:text-slate-400">Loading project info...</span>
			</div>
		{:else if error && !data}
			<div class="flex flex-col items-center gap-3 py-8">
				<Icon name="lucide:circle-x" class="w-8 h-8 text-red-400" />
				<p class="text-sm text-red-600 dark:text-red-400">{error}</p>
				<button
					type="button"
					class="px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-medium hover:bg-violet-700"
					onclick={() => {
						if (!project?.id) return;
						token++;
						loading = true;
						error = null;
						void fetchInfo(project.id, token, true);
					}}
				>
					Retry
				</button>
			</div>
		{:else if data}
			<div class="flex flex-col gap-5">
				<!-- Header: name + path -->
				<div class="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl">
					<div class="w-10 h-10 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center shrink-0">
						<Icon name="lucide:folder" class="w-5 h-5 text-violet-600 dark:text-violet-400" />
					</div>
					<div class="flex-1 min-w-0">
						<p class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{data.project.name}</p>
						<div class="flex items-center gap-1.5 mt-0.5">
							<p class="text-xs font-mono text-slate-500 dark:text-slate-400 truncate flex-1 min-w-0" title={data.project.path}>
								{data.project.path}
							</p>
							<button
								type="button"
								class="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors"
								onclick={copyPath}
								title={copied ? 'Copied!' : 'Copy path'}
								aria-label="Copy path"
							>
								<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
							</button>
						</div>
						<p class="text-3xs text-slate-400 dark:text-slate-500 mt-1">
							Created {new Date(data.project.created_at).toLocaleDateString()} · {data.meta.platform}
							{data.meta.arch} · {data.meta.logicalCores} cores
						</p>
					</div>
					<span
						class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border
							{data.resources.status === 'running'
							? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800'
							: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'}"
					>
						<span class="w-2 h-2 rounded-full {data.resources.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-slate-400'}"></span>
						{data.resources.status === 'running' ? 'Running' : 'Not Running'}
					</span>
				</div>

				<!-- Resource cards: CPU / RAM / Storage (per-project only) -->
				<div class="grid grid-cols-3 gap-3">
					<!-- CPU -->
					<div class="flex flex-col gap-2 p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl">
						<div class="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
							<Icon name="lucide:cpu" class="w-3.5 h-3.5 text-violet-500" />
							CPU
							<span
								class="ml-auto w-2 h-2 rounded-full {data.resources.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-slate-300 dark:bg-slate-600'}"
								title={data.resources.status === 'running' ? 'Resource active — live process' : 'Inactive — no process'}
							></span>
						</div>
						{#if data.resources.status === 'not_running'}
							<p class="text-lg font-bold text-slate-400 dark:text-slate-500">0%</p>
							<p class="text-2xs text-slate-400 dark:text-slate-500">No active process</p>
						{:else}
							<p class="text-lg font-bold text-slate-900 dark:text-slate-100">{formatPercent(data.resources.cpuPercent)}</p>
							<p class="text-2xs text-slate-500 dark:text-slate-400">
								{#if data.resources.cpuPercent === null}
									Measuring…
								{:else}
									{data.resources.processCount} process{data.resources.processCount !== 1 ? 'es' : ''} · {data.resources.rootPids.length}
									shell{data.resources.rootPids.length !== 1 ? 's' : ''}
								{/if}
							</p>
						{/if}
					</div>

					<!-- RAM -->
					<div class="flex flex-col gap-2 p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl">
						<div class="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
							<Icon name="lucide:memory-stick" class="w-3.5 h-3.5 text-blue-500" />
							RAM
							<span
								class="ml-auto w-2 h-2 rounded-full {data.resources.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-slate-300 dark:bg-slate-600'}"
								title={data.resources.status === 'running' ? 'Resource active — live process' : 'Inactive — no process'}
							></span>
						</div>
						{#if data.resources.status === 'not_running'}
							<p class="text-lg font-bold text-slate-400 dark:text-slate-500">0 B</p>
							<p class="text-2xs text-slate-400 dark:text-slate-500">No active process</p>
						{:else if data.resources.memRssBytes === null}
							<p class="text-lg font-bold text-slate-400 dark:text-slate-500">—</p>
							<p class="text-2xs text-slate-400 dark:text-slate-500">Unavailable</p>
						{:else}
							<p class="text-lg font-bold text-slate-900 dark:text-slate-100">{formatBytes(data.resources.memRssBytes)}</p>
							<p class="text-2xs text-slate-500 dark:text-slate-400">{formatPercent(data.resources.memPercent)} of host memory</p>
						{/if}
					</div>

					<!-- Storage -->
					<div class="flex flex-col gap-2 p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl">
						<div class="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
							<Icon name="lucide:hard-drive" class="w-3.5 h-3.5 text-amber-500" />
							Storage
						</div>
						{#if data.storage.error}
							<p class="text-xs text-red-500 truncate" title={data.storage.error}>Unavailable</p>
						{:else}
							<p class="text-lg font-bold text-slate-900 dark:text-slate-100">{formatBytes(data.storage.sizeBytes)}</p>
							<p class="text-2xs text-slate-500 dark:text-slate-400">
								{data.storage.fileCount.toLocaleString()} files · {data.storage.dirCount.toLocaleString()} dirs
								{#if data.storage.truncated}
									<span class="text-amber-600 dark:text-amber-400"> (partial)</span>
								{/if}
							</p>
						{/if}
					</div>
				</div>

				<!-- Process list (only when running) -->
				{#if data.resources.status === 'running' && data.resources.processes.length > 0}
					<div class="flex flex-col gap-2">
						<h3 class="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
							<Icon name="lucide:list-tree" class="w-3.5 h-3.5" />
							Processes ({data.resources.processCount})
						</h3>
						<div class="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
							<div class="max-h-48 overflow-y-auto">
								<table class="w-full text-xs">
									<thead class="sticky top-0 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
										<tr class="text-left text-slate-500 dark:text-slate-400">
											<th class="px-3 py-2 font-medium">PID</th>
											<th class="px-3 py-2 font-medium">Name</th>
											<th class="px-3 py-2 font-medium text-right">CPU</th>
											<th class="px-3 py-2 font-medium text-right">RAM</th>
										</tr>
									</thead>
									<tbody class="divide-y divide-slate-100 dark:divide-slate-800">
										{#each data.resources.processes as proc (proc.pid)}
											<tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50">
												<td class="px-3 py-1.5 font-mono text-slate-600 dark:text-slate-400">{proc.pid}</td>
												<td class="px-3 py-1.5 max-w-[180px] truncate text-slate-900 dark:text-slate-100" title={proc.command || proc.name}>{proc.name}</td>
												<td class="px-3 py-1.5 text-right font-mono text-slate-600 dark:text-slate-400">{formatPercent(proc.cpuPercent)}</td>
												<td class="px-3 py-1.5 text-right font-mono text-slate-600 dark:text-slate-400">{formatBytes(proc.memRssBytes)}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
						<p class="text-3xs text-slate-400 dark:text-slate-500">
							The terminal shells opened for this project and everything they spawned, as a share of the whole machine. Refreshes every {POLL_INTERVAL_MS /
								1000}s.
						</p>
					</div>
				{:else if data.resources.status === 'running' && data.resources.processes.length === 0}
					<div class="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-700 dark:text-amber-300">
						<Icon name="lucide:info" class="w-4 h-4 shrink-0" />
						{data.resources.rootPids.length} shell{data.resources.rootPids.length !== 1 ? 's' : ''} running, but the host process table could not be read.
					</div>
				{/if}

				{#if data.storage.truncated}
					<p class="text-3xs text-amber-600 dark:text-amber-400 text-center">
						Storage scan stopped early — the folder is larger than one pass covers, so the size is a floor, not a total.
					</p>
				{/if}

				{#if error}
					<p class="text-3xs text-red-500 text-center">Last refresh failed: {error}</p>
				{/if}
			</div>
		{/if}
	{/snippet}
</Modal>
