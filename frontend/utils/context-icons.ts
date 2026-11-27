/**
 * The icon a context attachment's card shows, by what it is a snapshot of —
 * the same icons the `@` picker lists them with.
 */

import type { ContextKind } from '$shared/types/mentions';
import type { IconName } from '$shared/types/ui/icons';

export const CONTEXT_ICONS: Record<ContextKind, IconName> = {
	file: 'lucide:file-code',
	folder: 'lucide:folder',
	code: 'lucide:text-select',
	terminal: 'lucide:square-terminal',
	'terminal-selection': 'lucide:square-terminal',
	'git-changes': 'lucide:file-diff',
	'git-staged': 'lucide:git-commit-horizontal',
	'git-file': 'lucide:file-diff',
	'git-commit': 'lucide:git-commit-horizontal',
	'git-branch': 'lucide:git-compare',
	'git-stash': 'lucide:archive',
	'git-conflicts': 'lucide:git-merge',
	'preview-tab': 'lucide:app-window',
	'preview-element': 'lucide:square-dashed-mouse-pointer',
	'preview-console': 'lucide:scroll-text',
	'chat-session': 'lucide:messages-square',
	'chat-message': 'lucide:message-square',
	project: 'lucide:folder-kanban',
	'ai-changes': 'lucide:sparkles',
	'work-item': 'lucide:circle-dot',
	note: 'lucide:notebook-pen',
	memory: 'lucide:brain',
	'db-connection': 'lucide:database',
	'db-table': 'lucide:table',
	'db-result': 'lucide:table',
	deployment: 'lucide:rocket',
	container: 'lucide:container',
	port: 'lucide:ethernet-port',
	'env-file': 'lucide:key-round'
};
