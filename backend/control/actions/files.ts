/**
 * Files — what the last turn changed, and getting a file out of a session.
 *
 * Paths are always the session's own working tree (its worktree when it has
 * one), never the whole disk: `/file ../../etc/passwd` is refused like any
 * path outside the tree, so a chat can read exactly what the web Files panel
 * of that session can.
 */

import { t } from 'elysia';
import { existsSync, readdirSync, statSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
import { resolveSessionPath, isPathInside } from '$backend/worktrees';
import { MAX_ATTACHMENT_BYTES } from '$shared/constants/attachments';
import { formatBytes } from '$backend/chat/attachments';
import type { ControlChoice } from '../types';
import { defineAction } from '../define';
import { paged } from '../paging';
import { accessibleSession, projectLabel, resolveTarget } from '../workspace';
import { escapeMd } from './projects';
import { sessionTitle } from './sessions';

interface TurnFile {
	path: string;
	status: 'added' | 'modified' | 'deleted';
	insertions: number;
	deletions: number;
	isBinary: boolean;
}

interface TurnChanges {
	turns: Array<{ turnIndex: number; promptText: string; files: TurnFile[] }>;
	net: { filesChanged: number; insertions: number; deletions: number };
}

const STATUS_MARK: Record<TurnFile['status'], string> = { added: '🆕', modified: '✏️', deleted: '🗑️' };

/** Entries that are never worth listing in a folder. */
const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store']);

/** The folder a session works in — its worktree when it has one. */
function workingRoot(userId: string, target: { projectId: string; sessionId: string | null }): string {
	const { project, session } = resolveTarget(userId, target);
	return session ? resolveSessionPath(session.id, project.path) : project.path;
}

export const turnDiff = defineAction({
	id: 'files.diff',
	group: 'files',
	title: 'Changes',
	description: 'Files the last turn changed',
	access: 'member',
	args: t.Object({}),
	command: { name: 'diff' },
	async run(ctx) {
		const found = accessibleSession(ctx.user.id, ctx.target.sessionId);
		if (!found) return { text: 'No session yet. Send a message first.' };
		const { turns, net } = await ctx.call<TurnChanges>('snapshot:list-turn-changes', { sessionId: found.session.id }, { projectId: found.project.id });
		const turn = turns.find((entry) => entry.files.length > 0);
		if (!turn) return { text: `No file has changed in **${escapeMd(sessionTitle(found.session))}**.` };

		const lines = turn.files.slice(0, 30).map((file) => {
			const counts = file.isBinary ? 'binary' : `+${file.insertions} −${file.deletions}`;
			return `${STATUS_MARK[file.status]} \`${file.path}\` ${counts}`;
		});
		const more = turn.files.length > 30 ? `\n…and ${turn.files.length - 30} more.` : '';
		const latest = turn === turns[0] ? 'the last turn' : `turn ${turn.turnIndex} (the latest that changed files)`;
		const total = `\n\n_Whole session: ${net.filesChanged} file${net.filesChanged === 1 ? '' : 's'}, +${net.insertions} −${net.deletions}._`;
		const choices: ControlChoice[] = turn.files
			.filter((file) => file.status !== 'deleted')
			.slice(0, 20)
			.map((file) => ({ label: basename(file.path), detail: file.path, action: 'files.get', args: { path: file.path } }));
		return { text: `**🧾 Files changed in ${latest}**\n\n${lines.join('\n')}${more}${total}`, choices };
	}
});

export const getFile = defineAction({
	id: 'files.get',
	group: 'files',
	title: 'Get a file',
	description: 'Get a file from the project, or browse its folders',
	access: 'member',
	args: t.Object({ path: t.Optional(t.String()), page: t.Optional(t.Number({ minimum: 0 })) }),
	command: { name: 'file', argument: { keys: ['path'], hint: '[path in the project]' } },
	async run(ctx, args) {
		const { project } = resolveTarget(ctx.user.id, ctx.target);
		const root = workingRoot(ctx.user.id, ctx.target);
		const requested = (args.path ?? '').trim().replace(/^["']|["']$/g, '').replace(/^\.\//, '');
		const full = resolve(root, requested || '.');
		if (!isPathInside(root, full)) throw new Error('Only files inside the project can be sent.');
		if (!existsSync(full)) throw new Error(`There is no \`${requested}\` in ${projectLabel(project)}.`);

		const shown = relative(root, full) || '.';
		const stats = statSync(full);
		if (stats.isDirectory()) {
			const entries = readdirSync(full, { withFileTypes: true })
				.filter((entry) => !HIDDEN.has(entry.name))
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
			if (entries.length === 0) return { text: `📂 \`${shown}\` is empty.` };
			const { choices, range } = paged(
				entries,
				args.page,
				(entry) => ({
					label: `${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`,
					action: 'files.get',
					args: { path: relative(root, join(full, entry.name)) }
				}),
				{ action: 'files.get', args: { path: shown } }
			);
			return { text: `**📂 \`${shown}\`** in ${escapeMd(projectLabel(project))}${range}`, choices };
		}
		if (stats.size > MAX_ATTACHMENT_BYTES) {
			throw new Error(`\`${shown}\` is ${formatBytes(stats.size)}, and a chat can only take files up to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
		}
		const mime = Bun.file(full).type.split(';')[0] || 'application/octet-stream';
		return { text: `📄 \`${shown}\` · ${formatBytes(stats.size)}`, files: [{ path: full, filename: basename(full), mime }] };
	}
});
