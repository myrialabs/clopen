<script lang="ts">
	/**
	 * A skill's revisions — every save, by the owner or by Clopen improving it —
	 * with a one-click way back. A revert is itself a revision, so nothing here
	 * loses anything.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { SkillVersion } from '$shared/types/assistant';

	let skills = $state<Array<{ slug: string; name: string }>>([]);
	let slug = $state('');
	let versions = $state<SkillVersion[]>([]);
	let open = $state<number | null>(null);
	let expanded = $state(false);

	async function loadSkills() {
		const { skills: list } = await ws.http('skills:list', {});
		skills = list.map((skill) => ({ slug: skill.slug, name: skill.name }));
	}

	async function loadVersions() {
		versions = slug ? ((await ws.http('assistant:skill-versions', { slug })) as SkillVersion[]) : [];
		open = null;
	}

	async function revert(version: number) {
		try {
			await ws.http('assistant:skill-revert', { slug, version });
			addNotification({ type: 'success', title: 'Skill reverted', message: `${slug} is back at version ${version}.` });
			await loadVersions();
		} catch (error) {
			addNotification({ type: 'error', title: 'Could not revert', message: error instanceof Error ? error.message : String(error) });
		}
	}

	$effect(() => {
		if (expanded && skills.length === 0) void loadSkills();
	});
</script>

<section class="mt-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60">
	<button type="button" class="w-full flex items-center gap-2 p-3.5 text-left bg-transparent border-none cursor-pointer" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
		<Icon name="lucide:history" class="w-4 h-4 text-violet-500" />
		<span class="flex-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Revision history</span>
		<span class="text-xs text-slate-500">Every change to a skill, including Clopen's improvements</span>
		<Icon name={expanded ? 'lucide:chevron-up' : 'lucide:chevron-down'} class="w-4 h-4 text-slate-400" />
	</button>
	{#if expanded}
		<div class="px-3.5 pb-3.5 space-y-3">
			<select class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm" bind:value={slug} onchange={loadVersions} aria-label="Skill">
				<option value="">Choose a skill…</option>
				{#each skills as skill (skill.slug)}<option value={skill.slug}>{skill.name}</option>{/each}
			</select>
			{#if slug && versions.length === 0}
				<p class="text-xs text-slate-500">No revisions recorded yet — the next save starts the history.</p>
			{/if}
			{#each versions as version, index (version.id)}
				<div class="rounded-lg border border-slate-200 dark:border-slate-800">
					<div class="flex items-center gap-2 p-2.5 text-sm">
						<span class="font-semibold text-slate-800 dark:text-slate-200">v{version.version}</span>
						<span class="text-xs text-slate-500">{version.note} · {version.createdBy === 'assistant' ? 'by Clopen' : 'by you'} · {new Date(version.createdAt).toLocaleString()}</span>
						<span class="flex-1"></span>
						<button type="button" class="text-xs text-violet-600 dark:text-violet-400 bg-transparent border-none cursor-pointer hover:underline" onclick={() => (open = open === version.id ? null : version.id)}>{open === version.id ? 'Hide' : 'View'}</button>
						{#if index > 0}
							<button type="button" class="text-xs text-violet-600 dark:text-violet-400 bg-transparent border-none cursor-pointer hover:underline" onclick={() => revert(version.version)}>Restore</button>
						{/if}
					</div>
					{#if open === version.id}
						<pre class="max-h-72 overflow-auto m-2.5 mt-0 p-2.5 rounded bg-slate-100 dark:bg-slate-950 text-2xs whitespace-pre-wrap">{version.content}</pre>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>
