<script lang="ts">
	/**
	 * Every hostname a build answers on, told apart by kind.
	 *
	 * A production build usually has three, and they are NOT interchangeable —
	 * which one you want depends entirely on what you are doing:
	 *
	 *   the project domain   follows whatever is live, so it is the one to share
	 *   the branch alias     follows the newest build of that branch
	 *   the build URL        pins this exact build forever, so it is the one to
	 *                        paste into a bug report
	 *
	 * Rendering all three with the same globe made them look like duplicates of
	 * one address. The kinds are inferred from the shape of the hostname, the
	 * same way the provider's own dashboard distinguishes them.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import { showInfo } from '$frontend/stores/ui/notification.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		domains: string[];
		/** Branch this build came from, which is what makes a branch alias one. */
		branch?: string | null;
		max?: number;
	}

	const { domains, branch = null, max = 4 }: Props = $props();

	type DomainKind = 'project' | 'branch' | 'build';

	const KIND_ICON: Record<DomainKind, IconName> = {
		project: 'lucide:globe',
		branch: 'lucide:git-branch',
		build: 'lucide:git-commit-horizontal'
	};

	const KIND_TITLE: Record<DomainKind, string> = {
		project: 'Project domain — always points at whatever is live',
		branch: 'Branch alias — points at the newest build of this branch',
		build: 'Build URL — pinned to this exact build'
	};

	/**
	 * Which kind a hostname is.
	 *
	 * A branch alias carries `-git-<branch>`; a build URL carries a generated
	 * segment of random characters. Anything else is the project's own domain,
	 * which is also the right fallback — a custom domain looks like nothing else
	 * and is the one a reader most expects to see first.
	 */
	function kindOf(domain: string): DomainKind {
		if (/-git-/.test(domain)) return 'branch';
		if (branch && domain.includes(`-git-${branch.replace(/[^a-z0-9]+/gi, '-')}`)) return 'branch';
		// `project-5vnwr-83m9tzmx9-owner.vercel.app` — a 9-ish character segment
		// of mixed letters and digits that no human would choose.
		if (/-[a-z0-9]{8,12}-/.test(domain)) return 'build';
		return 'project';
	}

	const shown = $derived(domains.slice(0, max).map((domain) => ({ domain, kind: kindOf(domain) })));

	async function copy(domain: string) {
		const ok = await copyText(`https://${domain}`);
		showInfo(ok ? 'Copied' : 'Could not copy', ok ? 'Domain copied.' : 'The clipboard refused the request.');
	}
</script>

<ul class="flex flex-col gap-1 list-none m-0 p-0">
	{#each shown as entry (entry.domain)}
		<li class="group flex items-center gap-1.5 min-w-0">
			<Icon
				name={KIND_ICON[entry.kind]}
				class="w-3.5 h-3.5 shrink-0 text-slate-400 dark:text-slate-600"
			/>
			<a
				href="https://{entry.domain}"
				target="_blank"
				rel="noopener noreferrer"
				title={KIND_TITLE[entry.kind]}
				class="min-w-0 truncate text-xs text-slate-700 dark:text-slate-300 no-underline hover:text-violet-600 dark:hover:text-violet-400 hover:underline"
			>
				{entry.domain}
			</a>
			<!--
				Always present, never hover-revealed: a touch screen has no hover,
				and a control that only exists on a pointer device does not exist.
			-->
			<button
				type="button"
				class="shrink-0 bg-transparent border-none p-0 text-slate-400 dark:text-slate-600 cursor-pointer hover:text-slate-700 dark:hover:text-slate-200"
				onclick={() => copy(entry.domain)}
				aria-label="Copy {entry.domain}"
			>
				<Icon name="lucide:copy" class="w-3.5 h-3.5" />
			</button>
		</li>
	{/each}
	{#if domains.length > max}
		<li class="pl-5 text-xs text-slate-400 dark:text-slate-600">
			and {domains.length - max} more
		</li>
	{/if}
</ul>
