import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { execGit } from '../../git/git-executor';
import { requireProjectAccess } from '../access';
import path from 'path';

export const ignoredHandler = createRouter()
	.http('git:ignored-paths', {
		data: t.Object({
			projectId: t.String()
		}),
		response: t.Object({
			ignored: t.Array(t.String())
		})
	}, async ({ data, conn }) => {
		const project = requireProjectAccess(conn, data.projectId);
		const ignored: string[] = [];

		try {
			const isRepo = await execGit(['rev-parse', '--is-inside-work-tree'], project.path, 5_000)
				.then(r => r.exitCode === 0)
				.catch(() => false);

			if (!isRepo) return { ignored };

			// Get ignored files (leaf paths)
			const filesResult = await execGit(
				['ls-files', '--others', '--ignored', '--exclude-standard'],
				project.path,
				30_000
			);
			if (filesResult.exitCode === 0) {
				const sep = project.path.includes('\\') ? '\\' : '/';
				for (const line of filesResult.stdout.split('\n')) {
					const relPath = line.trim();
					if (!relPath) continue;
					ignored.push(path.join(project.path, relPath.replace(/\//g, sep)));
				}
			}

			// Get ignored directories (shown with --directory flag)
			const dirsResult = await execGit(
				['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
				project.path,
				30_000
			);
			if (dirsResult.exitCode === 0) {
				const seen = new Set(ignored);
				const sep = project.path.includes('\\') ? '\\' : '/';
				for (const line of dirsResult.stdout.split('\n')) {
					const relPath = line.trim().replace(/\/$/, '');
					if (!relPath) continue;
					const absPath = path.join(project.path, relPath.replace(/\//g, sep));
					if (!seen.has(absPath)) {
						ignored.push(absPath);
						seen.add(absPath);
					}
				}
			}
		} catch {
			// If git fails, return empty
		}

		return { ignored };
	});
