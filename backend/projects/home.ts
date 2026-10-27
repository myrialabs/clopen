/**
 * Home workspaces — one per user, for chatting with no project selected.
 *
 * Home is a real project row pointing at a real directory, because every
 * engine needs a working directory and every chat path needs a project: the
 * cheapest correct "no project" is a project nobody had to pick. The directory
 * lives under Clopen's data dir (`home/<userId>`), so it is the user's scratch
 * space and never somebody's repository.
 *
 * Created on demand and idempotent: the project list, a chat channel's `/home`
 * and a first sign-in with nothing assigned all call `ensureHomeProject()`.
 * The unique index on `(owner_user_id) WHERE kind = 'home'` makes two racing
 * calls end with one Home.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { projectQueries } from '$backend/database/queries';
import { getClopenDir } from '$backend/utils/paths';
import { HOME_PROJECT_NAME } from '$shared/utils/home-project';
import type { Project } from '$shared/types/database/schema';
import { debug } from '$shared/utils/logger';

export function getHomeDirectory(userId: string): string {
	return join(getClopenDir(), 'home', userId);
}

export function ensureHomeProject(userId: string): Project {
	const existing = projectQueries.getHomeForUser(userId);
	const path = existing?.path ?? getHomeDirectory(userId);
	// Re-created every time: a "Clear All Data" or a hand-deleted folder must
	// not leave the engine starting in a directory that is not there.
	mkdirSync(path, { recursive: true });

	if (existing) {
		if (!projectQueries.userHasProject(userId, existing.id)) projectQueries.addUserProject(userId, existing.id);
		return existing;
	}

	const now = new Date().toISOString();
	try {
		const project = projectQueries.create({
			name: HOME_PROJECT_NAME,
			path,
			created_at: now,
			last_opened_at: now,
			kind: 'home',
			owner_user_id: userId
		});
		projectQueries.addUserProject(userId, project.id);
		debug.log('project', `Created Home workspace for user ${userId}`);
		return project;
	} catch (error) {
		// Lost a race with another tab: the other call's row is the Home.
		const raced = projectQueries.getHomeForUser(userId);
		if (raced) {
			if (!projectQueries.userHasProject(userId, raced.id)) projectQueries.addUserProject(userId, raced.id);
			return raced;
		}
		throw error;
	}
}
