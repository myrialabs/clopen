/**
 * Home workspace — one per install, for chatting with no project selected.
 *
 * Home is a real project row pointing at a real directory, because every
 * engine needs a working directory and every chat path needs a project: the
 * cheapest correct "no project" is a project nobody had to pick. The directory
 * lives under Clopen's data dir (`home/`), so it is a scratch space and never
 * somebody's repository.
 *
 * Created on demand and idempotent: the project list, a chat channel's `/home`
 * and a first sign-in with no project all call `ensureHomeProject()`. The
 * unique index on `(kind) WHERE kind = 'home'` makes two racing calls end with
 * one Home.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { projectQueries } from '$backend/database/queries';
import { getClopenDir } from '$backend/utils/paths';
import { HOME_PROJECT_NAME } from '$shared/utils/home-project';
import type { Project } from '$shared/types/database/schema';
import { debug } from '$shared/utils/logger';

export function getHomeDirectory(): string {
	return join(getClopenDir(), 'home');
}

export function ensureHomeProject(): Project {
	const existing = projectQueries.getHome();
	const path = existing?.path ?? getHomeDirectory();
	// Re-created every time: a "Clear All Data" or a hand-deleted folder must
	// not leave the engine starting in a directory that is not there.
	mkdirSync(path, { recursive: true });

	if (existing) {
		projectQueries.list(existing.id);
		return existing;
	}

	const now = new Date().toISOString();
	try {
		const project = projectQueries.create({
			name: HOME_PROJECT_NAME,
			path,
			created_at: now,
			last_opened_at: now,
			kind: 'home'
		});
		projectQueries.list(project.id);
		debug.log('project', 'Created Home workspace');
		return project;
	} catch (error) {
		// Lost a race with another tab: the other call's row is the Home.
		const raced = projectQueries.getHome();
		if (raced) {
			projectQueries.list(raced.id);
			return raced;
		}
		throw error;
	}
}
