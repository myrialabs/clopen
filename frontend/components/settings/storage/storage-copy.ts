/** Labels for Settings → Storage. The server sends ids; what they are called lives here. */

import type { CleanupActionId, StorageCategoryId } from '$shared/types/storage';
import type { EngineType } from '$shared/types/unified';
import type { IconName } from '$shared/types/ui/icons';
import { getEngineInfo } from '$shared/constants/engines';

export const CATEGORY_COPY: Record<StorageCategoryId, { label: string; hint: string; color: string }> = {
	chats: { label: 'Chat database', hint: 'Conversations, settings and everything else in app.db', color: 'bg-violet-500' },
	'engine-transcripts': { label: 'Engine transcripts', hint: 'Each engine’s own copy of every session, used to resume', color: 'bg-blue-500' },
	'engine-caches': { label: 'Engine caches & config', hint: 'Tool caches, logs, plugins and sign-ins in each engine’s home', color: 'bg-cyan-500' },
	snapshots: { label: 'Checkpoints', hint: 'File contents saved so a chat can restore them', color: 'bg-amber-500' },
	worktrees: { label: 'Worktrees', hint: 'Isolated copies of projects', color: 'bg-emerald-500' },
	'preview-profiles': { label: 'Preview browser', hint: 'Cookies, storage and cache of every workspace’s browser', color: 'bg-pink-500' },
	stack: { label: 'Stack', hint: 'Installed engines and runtimes', color: 'bg-slate-500' },
	other: { label: 'Other', hint: 'Binaries, notes, terminal history and small state', color: 'bg-slate-400' }
};

export const ACTION_COPY: Record<CleanupActionId, { label: string; description: string; icon: IconName; confirm?: string }> = {
	'orphan-transcripts': {
		label: 'Unused engine transcripts',
		description: 'Sessions on disk that no chat refers to any more, in every engine — left behind by deleted chats and one-off background calls.',
		icon: 'lucide:file-x'
	},
	'dedupe-transcripts': {
		label: 'Duplicate engine transcripts',
		description: 'Some engines copy the whole conversation into a new file every turn (today Claude Code). Copies already contained in a later one are removed; chats resume and branch exactly as before.',
		icon: 'lucide:copy'
	},
	'orphan-snapshots': {
		label: 'Unused checkpoint files',
		description: 'Saved file contents that no checkpoint refers to.',
		icon: 'lucide:history'
	},
	'orphan-profiles': {
		label: 'Leftover preview profiles',
		description: 'Browser profiles of projects and worktrees that no longer exist.',
		icon: 'lucide:globe'
	},
	'orphan-worktree-dirs': {
		label: 'Leftover worktree folders',
		description: 'Folders under worktrees with no worktree behind them.',
		icon: 'lucide:folder-x'
	},
	'legacy-engine-data': {
		label: 'Legacy engine data',
		description: 'Session stores an engine no longer reads since Clopen moved its data (today Open Code’s pre-pool store).',
		icon: 'lucide:archive'
	},
	'engine-logs': {
		label: 'Engine logs',
		description: 'Debug logs, telemetry and scratch files every engine wrote more than 7 days ago.',
		icon: 'lucide:scroll-text'
	},
	'browser-cache': {
		label: 'Preview browser cache',
		description: 'Cached pages, scripts and GPU data of every preview browser not open right now. Sign-ins and site data stay.',
		icon: 'lucide:brush-cleaning'
	},
	'tool-caches': {
		label: 'Tool caches',
		description: 'Model downloads, Python environments and package caches tools left in engine homes, plus engines’ own caches. Downloaded again when needed.',
		icon: 'lucide:package',
		confirm: 'The next task that needs one of these downloads it again, which can take a while for large models.'
	},
	'compact-database': {
		label: 'Compact database',
		description: 'Returns free space inside the database to the disk. The first run rebuilds the database, which pauses Clopen for about a minute; after that it is instant.',
		icon: 'lucide:database',
		confirm: 'The first compaction rebuilds the whole database. Clopen will not respond until it finishes, and it needs free disk space about the size of the database.'
	},
	'stale-worktrees': {
		label: 'Unused worktrees',
		description: 'Worktrees not opened for a while and with no changes left to apply. Worktrees with changes are never removed.',
		icon: 'lucide:git-branch',
		confirm: 'Each worktree folder is deleted, including anything in it that is not tracked as a change, such as build output.'
	},
	'project-profiles': {
		label: 'Preview browser data',
		description: 'Signs this project’s preview browsers out of every site and clears their storage and cache.',
		icon: 'lucide:eraser',
		confirm: 'Every site you signed in to in this project’s preview will ask you to sign in again.'
	},
	'slim-old-chats': {
		label: 'Slim old chats',
		description: 'Keeps every message; removes long tool output, attachments, file checkpoints and engine transcripts. Continuing a slimmed chat replays it to the engine.',
		icon: 'lucide:scissors',
		confirm: 'Slimmed chats can no longer restore files from their checkpoints, and long tool output in them is cut short. This cannot be undone.'
	},
	'delete-old-chats': {
		label: 'Delete old chats',
		description: 'Permanently deletes chats with no activity, with everything that belongs to them. The chat a project has open, a chat app’s current chat and chats linked to an issue are kept.',
		icon: 'lucide:trash-2',
		confirm: 'Deleted chats cannot be recovered.'
	}
};

export function engineLabel(engine: EngineType): string {
	return getEngineInfo(engine)?.name ?? engine;
}

export function formatRelative(iso: string | null): string {
	if (!iso) return 'never';
	const diff = Date.now() - Date.parse(iso);
	if (!Number.isFinite(diff)) return 'never';
	const minutes = Math.round(diff / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 60) return `${days} d ago`;
	return `${Math.round(days / 30)} mo ago`;
}
