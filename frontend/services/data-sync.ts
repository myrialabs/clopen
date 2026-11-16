/**
 * Auto-sync — the screen follows changes made anywhere.
 *
 * The server announces `data:changed { namespace }` after every write in a
 * shared namespace, whoever made it: another tab, another device, an agent
 * through the `run` tool, a Telegram command, an automation. Each namespace
 * maps to the refetch of what the screen shows for it. A view that keeps its
 * own copy (a modal's list) can subscribe with `onDataChanged`.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { projectState, refreshProjectList } from '$frontend/stores/core/projects.svelte';

type Refresh = () => unknown;

const listeners = new Map<string, Set<Refresh>>();

/** The refetch behind each namespace, loaded on use so this module stays light. */
const DEFAULTS: Record<string, Refresh> = {
	projects: refreshProjectList,
	skills: async () => (await import('$frontend/stores/features/skills.svelte')).skillsStore.refreshInstalled(),
	subagents: async () => (await import('$frontend/stores/features/subagents.svelte')).subagentsStore.refreshInstalled(),
	toolsets: async () => (await import('$frontend/stores/features/profiles.svelte')).profilesStore.refresh(),
	mcp: async () => (await import('$frontend/stores/features/mcp-servers.svelte')).mcpServersStore.refreshInstalled(),
	integrations: async () => (await import('$frontend/stores/features/integrations.svelte')).integrationsStore.refresh(),
	permissions: async () => (await import('$frontend/stores/features/permissions.svelte')).permissionsStore.refreshSets(),
	worktrees: async () => (await import('$frontend/stores/features/worktrees.svelte')).loadWorktrees(),
	library: async () => {
		const projectId = projectState.currentProject?.id;
		if (projectId) await (await import('$frontend/stores/features/project-artifacts.svelte')).projectArtifactsStore.refresh(projectId);
	},
	settings: async () => (await import('$frontend/stores/features/settings.svelte')).loadSystemSettings()
};

/** Run `refresh` whenever `namespace` changes anywhere. Returns the unsubscribe. */
export function onDataChanged(namespace: string, refresh: Refresh): () => void {
	const set = listeners.get(namespace) ?? new Set<Refresh>();
	set.add(refresh);
	listeners.set(namespace, set);
	return () => set.delete(refresh);
}

async function run(label: string, refresh: Refresh): Promise<void> {
	try {
		await refresh();
	} catch (error) {
		debug.warn('websocket', `Refreshing ${label} after a change failed:`, error);
	}
}

let started = false;

/** Once, when the workspace is ready. */
export function initDataSync(): void {
	if (started) return;
	started = true;
	ws.on('data:changed', (data: { namespace: string }) => {
		const fallback = DEFAULTS[data.namespace];
		if (fallback) void run(data.namespace, fallback);
		for (const refresh of listeners.get(data.namespace) ?? []) void run(data.namespace, refresh);
	});
}
