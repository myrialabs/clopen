/**
 * Where the project runs: its deployments and the containers on this machine.
 *
 * A deployment is attached with its build log — the thing asked about when a
 * build fails. A container is attached with how it is set up and what it wrote
 * last. Both talk to something outside Clopen, so they are only listed when
 * their category is opened, never on a keystroke at the root.
 */

import type { MentionCandidate } from '$shared/types/mentions';
import { LOCAL_HOST_ID } from '$shared/types/host';
import { buildContextDocument, countLines } from '$shared/utils/context-document';
import { deployService } from '$backend/deployments/service';
import { containerMonitor } from '$backend/containers/monitor';
import { inspectContainer, readRecentLogs } from '$backend/containers/actions';
import { sshConnectionQueries } from '$backend/database/queries';
import { ago, rank, within } from '../shared';
import { refOptional, refString, type MentionSource } from '../types';

const DEPLOYMENTS = 'deployments';
const CONTAINERS = 'containers';

/** The local machine, or a saved SSH host that still exists. */
function requireHost(hostId: string): void {
	if (hostId !== LOCAL_HOST_ID) sshConnectionQueries.require(hostId);
}

export const deploymentsSource: MentionSource = {
	kinds: ['deployment'],

	categories: () => [{ id: DEPLOYMENTS, label: 'Deployments', detail: 'Builds and their logs', icon: 'lucide:rocket', group: 'Ops' }],

	async list(ctx, request) {
		if (request.category !== DEPLOYMENTS) return [];
		const sources = await within(deployService.listSources(ctx.projectId, ctx.projectPath), 10_000, []);
		const rows: MentionCandidate[] = [];
		for (const source of sources.filter((entry) => entry.binding && entry.status === 'ok')) {
			const page = await within(deployService.list(ctx.projectId, source.accountId, { environment: 'all' }), 10_000, null);
			for (const deployment of page?.items.slice(0, 20) ?? []) {
				rows.push({
					key: `deployment:${source.accountId}:${deployment.id}`,
					kind: 'deployment',
					group: source.providerName,
					label: deployment.commitMessage?.split('\n')[0] || deployment.name,
					detail: [deployment.state, deployment.environment, deployment.branch, ago(deployment.createdAt)].filter(Boolean).join(' · '),
					icon: 'lucide:rocket',
					ref: { accountId: source.accountId, deploymentId: deployment.id }
				});
			}
		}
		return rank(rows, request.query, (row) => [row.label, row.detail], request.limit);
	},

	async capture(ctx, _kind, ref) {
		const accountId = refString(ref, 'accountId');
		const deploymentId = refString(ref, 'deploymentId');
		const detail = await deployService.get(ctx.projectId, accountId, deploymentId);
		const logs = await deployService.fetchLogs(ctx.projectId, accountId, deploymentId).catch(() => null);
		return {
			documents: [buildContextDocument({
				kind: 'deployment',
				label: detail.commitMessage?.split('\n')[0] || detail.name,
				detail: `${detail.state} · ${detail.environment}`,
				facts: [
					['Project', detail.name], ['State', `${detail.state} (${detail.stateDetail})`], ['Environment', detail.environment],
					['URL', detail.url], ['Dashboard', detail.inspectorUrl], ['Branch', detail.branch], ['Commit', detail.commitSha],
					['Created', detail.createdAt], ['Error', [detail.errorCode, detail.errorMessage].filter(Boolean).join(': ') || null]
				],
				sections: [{
					title: `Build log${logs?.truncated ? ' (the provider cut it short)' : ''}`,
					body: logs?.text || 'The provider returned no log.',
					fence: 'text'
				}]
			})]
		};
	}
};

export const containersSource: MentionSource = {
	kinds: ['container'],

	categories: () => [{ id: CONTAINERS, label: 'Containers', detail: 'On this machine', icon: 'lucide:container', group: 'Ops' }],

	async list(_ctx, request) {
		if (request.category !== CONTAINERS) return [];
		const scan = await within(containerMonitor.scanOnce(LOCAL_HOST_ID), 15_000, null);
		const rows = (scan?.entries ?? []).map((entry): MentionCandidate => ({
			key: `container:${entry.id}`,
			kind: 'container',
			group: 'Containers',
			label: entry.name,
			detail: `${entry.image} · ${entry.statusText}`,
			icon: 'lucide:container',
			ref: { hostId: LOCAL_HOST_ID, containerId: entry.id, name: entry.name }
		}));
		return rank(rows, request.query, (row) => [row.label, row.detail], request.limit);
	},

	async capture(_ctx, _kind, ref) {
		const hostId = refOptional(ref, 'hostId') ?? LOCAL_HOST_ID;
		requireHost(hostId);
		const containerId = refString(ref, 'containerId');
		const entry = await containerMonitor.findContainer(hostId, containerId);
		if (!entry) throw new Error('That container no longer exists');
		const inspected = await inspectContainer(hostId, containerId).catch(() => null);
		const logs = (await readRecentLogs(hostId, containerId)) ?? '';
		return {
			documents: [buildContextDocument({
				kind: 'container',
				label: entry.name,
				detail: entry.statusText,
				facts: [
					['Host', hostId === LOCAL_HOST_ID ? 'this machine' : hostId], ['Image', entry.image], ['Id', entry.shortId],
					['State', `${entry.state} · ${entry.statusText}`], ['Health', entry.health], ['Command', entry.command],
					['Ports', entry.ports.map((port) => `${port.hostPort ? `${port.hostAddress ?? ''}:${port.hostPort}->` : ''}${port.containerPort}/${port.protocol}`).join(', ') || null],
					['Compose', entry.composeProject ? `${entry.composeProject} / ${entry.composeService}` : null]
				],
				sections: [
					...(inspected ? [{ title: 'Inspect', body: JSON.stringify(inspected, null, 2), fence: 'json' }] : []),
					{ title: `Recent logs · ${countLines(logs)}`, body: logs || 'No output.', fence: 'text' }
				]
			})]
		};
	}
};
