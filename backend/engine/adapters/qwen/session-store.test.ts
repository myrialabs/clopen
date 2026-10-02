import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getQwenRuntimeDir, sessionStateExists } from './session-store';

// The CLI keys a project's chats on `sanitizeCwd(process.cwd())`, and the OS
// reports that cwd with symlinks resolved. A project opened through a symlink
// must still find its chats, or every resume silently skips the fork.
describe('sessionStateExists', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clopen-qwen-store-'));
	const realProject = path.join(fs.realpathSync(tmp), 'real-project');
	const linkedProject = path.join(tmp, 'linked-project');
	fs.mkdirSync(realProject);
	fs.symlinkSync(realProject, linkedProject);

	const sanitized = realProject.replace(/[^a-zA-Z0-9]/g, '-');
	const chatsDir = path.join(getQwenRuntimeDir(), 'projects', sanitized, 'chats');
	const sessionId = 'f0e1d2c3-0000-4000-8000-000000000001';
	fs.mkdirSync(chatsDir, { recursive: true });
	fs.writeFileSync(path.join(chatsDir, `${sessionId}.jsonl`), '{}\n');

	afterAll(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		fs.rmSync(path.join(getQwenRuntimeDir(), 'projects', sanitized), { recursive: true, force: true });
	});

	test('finds a chat through the real project path', () => {
		expect(sessionStateExists(realProject, sessionId)).toBe(true);
	});

	test('finds the same chat through a symlinked project path', () => {
		expect(sessionStateExists(linkedProject, sessionId)).toBe(true);
	});

	test('reports a missing chat as missing', () => {
		expect(sessionStateExists(realProject, 'f0e1d2c3-0000-4000-8000-00000000dead')).toBe(false);
	});
});
