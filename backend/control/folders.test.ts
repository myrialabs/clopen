/**
 * Managing folders from a chat while adding a project: making, renaming and
 * deleting work on ordinary folders, never on a project's or above home. A
 * project's own folder is renamed through the project, which moves with it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { initializeDatabase, closeDatabase } from '$backend/database';
import { projectQueries } from '$backend/database/queries';
import { createControlContext, getControlAction, registerControlRouter, runControlAction } from './index';
import { projectsRouter } from '$backend/ws/projects';

const admin = { id: 'folders-admin', name: 'Admin', role: 'admin' } as never;
const ctx = () => createControlContext(admin, { projectId: 'none', sessionId: null });

let root: string;
let projectId: string;

beforeAll(async () => {
	await initializeDatabase();
	// The project rename goes through the same WebSocket route the web UI uses.
	registerControlRouter(projectsRouter);
	root = mkdtempSync(join(tmpdir(), 'clopen-folders-'));
	mkdirSync(join(root, 'project'));
	projectId = projectQueries.create({ name: 'folders-test', path: join(root, 'project'), created_at: new Date().toISOString(), last_opened_at: new Date().toISOString() } as never).id;
});

afterAll(() => {
	projectQueries.deleteProject(projectId);
	rmSync(root, { recursive: true, force: true });
	closeDatabase();
});

describe('folders while adding a project', () => {
	it('asks for a name, then makes the folder and opens it', async () => {
		const asked = await runControlAction(ctx(), 'projects.mkdir', { path: root });
		expect(asked.ask).toMatchObject({ action: 'projects.mkdir', key: 'name', args: { path: root } });
		const made = await runControlAction(ctx(), 'projects.mkdir', { path: root, name: 'fresh' });
		expect(existsSync(join(root, 'fresh'))).toBe(true);
		expect(made.text).toContain('Created');
		expect(made.choices?.some((choice) => choice.action === 'projects.create')).toBe(true);
	});

	it('refuses names that are paths', async () => {
		for (const name of ['../escape', 'a/b', '..', ' ']) {
			await expect(runControlAction(ctx(), 'projects.mkdir', { path: root, name })).rejects.toThrow(/not a folder name/);
		}
	});

	it('renames and deletes an ordinary folder, the delete asked first', async () => {
		mkdirSync(join(root, 'old'));
		writeFileSync(join(root, 'old', 'a.txt'), 'a');
		await runControlAction(ctx(), 'projects.rename-folder', { path: join(root, 'old'), name: 'new' });
		expect(existsSync(join(root, 'new', 'a.txt'))).toBe(true);
		expect(await getControlAction('projects.delete-folder')!.confirm!({ path: join(root, 'new') } as never, ctx())).toContain('1 item');
		await runControlAction(ctx(), 'projects.delete-folder', { path: join(root, 'new') });
		expect(existsSync(join(root, 'new'))).toBe(false);
	});

	it('never renames or deletes a project, a folder holding one, or home', async () => {
		await expect(runControlAction(ctx(), 'projects.delete-folder', { path: join(root, 'project') })).rejects.toThrow(/is the project/);
		await expect(runControlAction(ctx(), 'projects.rename-folder', { path: root, name: 'x' })).rejects.toThrow(/holds the project/);
		await expect(runControlAction(ctx(), 'projects.delete-folder', { path: homedir() })).rejects.toThrow(/home folder/);
		expect(existsSync(join(root, 'project'))).toBe(true);
		const menu = await runControlAction(ctx(), 'projects.browse', { path: join(root, 'project') });
		expect(menu.choices?.some((choice) => choice.action === 'projects.delete-folder')).toBe(false);
		expect(menu.choices?.some((choice) => choice.action === 'projects.rename')).toBe(true);
	});

	it('renames a project with its folder: asks for the name, then moves both', async () => {
		projectQueries.list(projectId);
		const asked = await runControlAction(ctx(), 'projects.rename', { projectId });
		expect(asked.ask).toMatchObject({ action: 'projects.rename', key: 'name', args: { projectId } });

		const done = await runControlAction(ctx(), 'projects.rename', { projectId, name: 'project-renamed' });
		expect(done.text).toContain('Renamed to');
		expect(existsSync(join(root, 'project-renamed'))).toBe(true);
		expect(existsSync(join(root, 'project'))).toBe(false);
		expect(projectQueries.getById(projectId)).toMatchObject({ name: 'project-renamed', path: join(root, 'project-renamed') });

		// A plain folder rename of a project's folder hands over to the project rename.
		const handed = await runControlAction(ctx(), 'projects.rename-folder', { path: join(root, 'project-renamed'), name: 'x' });
		expect(handed.choices?.[0]).toMatchObject({ action: 'projects.rename', args: { projectId } });
		expect(existsSync(join(root, 'project-renamed'))).toBe(true);

		await runControlAction(ctx(), 'projects.rename', { projectId, name: 'project' });
		expect(projectQueries.getById(projectId)?.path).toBe(join(root, 'project'));
	});
});
