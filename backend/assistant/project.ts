/**
 * The Clopen assistant's workspace — one per install.
 *
 * A real project row pointing at a real directory, because every engine needs
 * a working directory and every chat path needs a project: the cheapest
 * correct "talk to Clopen itself" is a project nobody had to pick. The
 * directory lives under Clopen's data dir (`home/`, its pre-v0.5 name, kept so
 * an existing install's sessions keep their working directory), so it is a
 * scratch space and never somebody's repository.
 *
 * Created on demand and idempotent: the project list, a chat channel's
 * `/clopen` and a first sign-in all call `ensureAssistantProject()`. The unique
 * index on the stored kind makes two racing calls end with one row. An install
 * from before v0.5 named the row "Home"; it is renamed in place on first use.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { getDatabase } from '$backend/database';
import { projectQueries } from '$backend/database/queries';
import { getClopenDir } from '$backend/utils/paths';
import { ASSISTANT_NAME, ASSISTANT_PROJECT_KIND } from '$shared/utils/assistant-project';
import type { Project } from '$shared/types/database/schema';
import { debug } from '$shared/utils/logger';

export function getAssistantDirectory(): string {
	return join(getClopenDir(), 'home');
}

export function ensureAssistantProject(): Project {
	const existing = projectQueries.getAssistant();
	const path = existing?.path ?? getAssistantDirectory();
	// Re-created every time: a "Clear All Data" or a hand-deleted folder must
	// not leave the engine starting in a directory that is not there.
	mkdirSync(path, { recursive: true });

	if (existing) {
		projectQueries.list(existing.id);
		if (existing.name !== ASSISTANT_NAME) {
			getDatabase().prepare('UPDATE projects SET name = ? WHERE id = ?').run(ASSISTANT_NAME, existing.id);
			return { ...existing, name: ASSISTANT_NAME };
		}
		return existing;
	}

	const now = new Date().toISOString();
	try {
		const project = projectQueries.create({
			name: ASSISTANT_NAME,
			path,
			created_at: now,
			last_opened_at: now,
			kind: ASSISTANT_PROJECT_KIND
		});
		projectQueries.list(project.id);
		debug.log('project', 'Created the Clopen assistant workspace');
		return project;
	} catch (error) {
		// Lost a race with another tab: the other call's row is the one.
		const raced = projectQueries.getAssistant();
		if (raced) {
			projectQueries.list(raced.id);
			return raced;
		}
		throw error;
	}
}
