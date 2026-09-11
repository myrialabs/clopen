/**
 * How a capability is named and pictured in the hub.
 *
 * Kept next to the components rather than in the shared types: the backend
 * cares which surface a capability projects onto, and the UI cares what to call
 * it. Those drift for good reasons — `agent-tools` is "Agent tools" here and an
 * `mcp_servers` row there.
 */

import type { IntegrationCapability, IntegrationCategory } from '$shared/types/integrations';
import type { IconName } from '$shared/types/ui/icons';

export const CAPABILITY_LABELS: Record<IntegrationCapability, string> = {
	'agent-tools': 'Agent tools',
	work: 'Issues & PRs',
	deployments: 'Deployments',
	database: 'Database',
	'worktree-branching': 'Worktree branching',
	notifications: 'Notifications',
	'inbound-events': 'Inbound events'
};

/** Where the capability's work actually happens — shown so "connect" ≠ "use". */
export const CAPABILITY_SURFACES: Record<IntegrationCapability, string> = {
	'agent-tools': 'Available to every engine as MCP tools',
	work: 'More Tools → Issues & PRs',
	deployments: 'Deployments panel',
	database: 'DB Client',
	'worktree-branching': 'Worktree manager',
	notifications: 'Notification channels',
	'inbound-events': 'Inbound webhook gateway'
};

/** Fallback glyph when a provider has no brand mark yet. */
export const CATEGORY_ICONS: Record<IntegrationCategory, IconName> = {
	'source-control': 'lucide:git-branch',
	issues: 'lucide:circle-dot',
	deployment: 'lucide:rocket',
	database: 'lucide:database',
	observability: 'lucide:activity',
	chat: 'lucide:message-circle',
	research: 'lucide:book-open',
	design: 'lucide:palette',
	'developer-services': 'lucide:wrench',
	secrets: 'lucide:key-round'
};

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
	'source-control': 'Source control',
	issues: 'Issues',
	deployment: 'Deployment',
	database: 'Database',
	observability: 'Observability',
	chat: 'Chat',
	research: 'Research',
	design: 'Design',
	'developer-services': 'Developer services',
	secrets: 'Secrets'
};
