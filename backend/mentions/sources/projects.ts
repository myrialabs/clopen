/**
 * Another project: where it is and what it is.
 *
 * The overview is what someone opening the project would read first — its
 * readme and agent instructions, the top of its tree, its git state — plus its
 * path, so an engine that can reach it can read on from there.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { Project } from '$shared/types/database/schema';
import type { MentionCandidate } from '$shared/types/mentions';
import { buildContextDocument, type ContextSection } from '$shared/utils/context-document';
import { projectQueries } from '$backend/database/queries';
import { SKIP_DIRS } from '$backend/ws/files/search';
import { ago, gitText, rank, wants } from '../shared';
import { refString, type MentionSource } from '../types';

const CATEGORY = 'projects';

/** Files that describe a project, in the order they are worth reading. */
const DESCRIBING_FILES = ['README.md', 'readme.md', 'README', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
const MAX_DESCRIBING_BYTES = 60_000;

function projectRow(project: Project): MentionCandidate {
	return {
		key: `project:${project.id}`,
		kind: 'project',
		group: 'Projects',
		label: project.name,
		detail: `${project.path} · opened ${ago(project.last_opened_at)}`,
		icon: 'lucide:folder-kanban',
		ref: { projectId: project.id }
	};
}

async function topOfTree(root: string): Promise<string> {
	const lines: string[] = [];
	const visit = async (dir: string, prefix: string, depth: number) => {
		let entries;
		try {
			entries = (await readdir(dir, { withFileTypes: true })).filter((entry) => !SKIP_DIRS.has(entry.name) && entry.name !== '.git');
		} catch {
			return;
		}
		entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
		for (const entry of entries.slice(0, 60)) {
			lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
			if (entry.isDirectory() && depth < 1) await visit(join(dir, entry.name), `${prefix}  `, depth + 1);
		}
		if (entries.length > 60) lines.push(`${prefix}… ${entries.length - 60} more`);
	};
	await visit(root, '', 0);
	return lines.join('\n');
}

export const projectsSource: MentionSource = {
	kinds: ['project'],

	categories: () => [{ id: CATEGORY, label: 'Projects', detail: 'Other projects in Clopen', icon: 'lucide:folder-kanban', group: 'Projects' }],

	async list(ctx, request) {
		const mode = wants(request.category, CATEGORY);
		if (!mode || (mode === 'root' && !request.query.trim())) return [];
		const projects = projectQueries
			.getListed()
			.filter((project) => project.id !== ctx.projectId && project.kind !== 'home')
			.sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? ''));
		return rank(projects, request.query, (project) => [project.name, project.path], mode === 'root' ? 3 : request.limit).map(projectRow);
	},

	async capture(_ctx, _kind, ref) {
		const project = projectQueries.getById(refString(ref, 'projectId'));
		if (!project || !projectQueries.isListed(project.id)) throw new Error('That project is gone');

		const sections: ContextSection[] = [];
		const tree = await topOfTree(project.path);
		sections.push({ title: 'Top of the tree', body: tree || '(empty or unreadable)', fence: '' });

		const branch = (await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], project.path))?.trim();
		if (branch) {
			const status = await gitText(['status', '--short'], project.path);
			const log = await gitText(['log', '--oneline', '-n', '10'], project.path);
			sections.push({ title: `Git · ${branch}`, body: `${status?.trim() || 'Clean working tree.'}\n\nRecent commits:\n${log?.trim() ?? ''}`, fence: '' });
		}

		let budget = MAX_DESCRIBING_BYTES;
		// A case-insensitive disk answers README.md and readme.md with one file.
		const read = new Set<string>();
		for (const name of DESCRIBING_FILES) {
			if (budget <= 0) break;
			if (read.has(name.toLowerCase())) continue;
			try {
				const text = await readFile(join(project.path, name), 'utf8');
				read.add(name.toLowerCase());
				const body = text.length > budget ? `${text.slice(0, budget)}\n… (cut short)` : text;
				budget -= body.length;
				sections.push({ title: name, body, fence: name.endsWith('.md') || name === 'README' ? undefined : '' });
			} catch {
				// Not every project has every file.
			}
		}

		return {
			documents: [buildContextDocument({
				kind: 'project',
				label: project.name,
				detail: project.path,
				facts: [['Path', project.path], ['Branch', branch ?? null]],
				sections
			})]
		};
	}
};
