import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { mkdir, symlink, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';

const isWindows = platform() === 'win32';

// Symlinks on Windows require admin privileges. Skip symlink-specific tests
// when running without elevated permissions.
async function canCreateSymlinks(): Promise<boolean> {
	const testPath = join(tmpdir(), `symlink-test-${randomUUID()}`);
	const targetPath = join(tmpdir(), `symlink-target-${randomUUID()}`);
	try {
		await mkdir(targetPath, { recursive: true });
		await symlink(targetPath, testPath, 'dir');
		await rm(testPath);
		await rm(targetPath, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

// Mock dependencies before importing the module under test
const mockGetAll = mock(() => [] as Array<{ id: string; path: string }>);
const mockGetByPath = mock(() => null as { id: string; path: string } | null);
const mockGetById = mock(() => null as { id: string; path: string } | null);

mock.module('../../database/queries/project-queries', () => ({
	projectQueries: {
		getAll: mockGetAll,
		getByPath: mockGetByPath,
		getById: mockGetById,
	}
}));

const mockWorktreeByPath = mock(() => null as { id: string; project_id: string; path: string } | null);

mock.module('../../database/queries/worktree-queries', () => ({
	worktreeQueries: {
		getByProjectId: mock(() => []),
		getByPath: mockWorktreeByPath,
	}
}));

// Import after mocking
const { resolveFilePath, findContainingProjectId, resolveProjectForRoot, requireWorkspaceRoot } = await import('./path-access');

let testDir: string;

describe('workspace roots', () => {
	beforeEach(async () => {
		const rawTestDir = join(tmpdir(), `clopen-path-access-test-${randomUUID()}`);
		await mkdir(rawTestDir, { recursive: true });
		// Canonicalize so test expectations match what resolveRealPath returns.
		// macOS tmpdir lives under /var → /private/var, which realpath follows.
		testDir = await realpath(rawTestDir);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		mockWorktreeByPath.mockReturnValue(null);
	});

	test('resolves a worktree root back to its owning project', async () => {
		const worktreePath = join(testDir, 'worktrees', 'feature');
		mockGetByPath.mockReturnValue(null);
		mockWorktreeByPath.mockReturnValue({ id: 'wt-1', project_id: 'proj-1', path: worktreePath });
		mockGetById.mockReturnValue({ id: 'proj-1', path: join(testDir, 'project') });

		expect(resolveProjectForRoot(worktreePath)?.id).toBe('proj-1');
	});

	test('returns the worktree root, not the project root, for a worktree path', async () => {
		// The regression this guards: handlers validated the requested root and
		// then operated on `project.path`, so opening a file in a worktree listed
		// and read the main tree instead.
		const projectPath = join(testDir, 'project');
		const worktreePath = join(testDir, 'worktrees', 'feature');

		mockGetByPath.mockReturnValue(null);
		mockWorktreeByPath.mockReturnValue({ id: 'wt-1', project_id: 'proj-1', path: worktreePath });
		mockGetById.mockReturnValue({ id: 'proj-1', path: projectPath });

		const resolved = requireWorkspaceRoot(worktreePath);
		expect(resolved.root).toBe(worktreePath);
		expect(resolved.worktreeId).toBe('wt-1');
		expect(resolved.project.id).toBe('proj-1');
	});

	test('returns the project root for the main tree', async () => {
		const projectPath = join(testDir, 'project');

		mockWorktreeByPath.mockReturnValue(null);
		mockGetByPath.mockReturnValue({ id: 'proj-1', path: projectPath });

		const resolved = requireWorkspaceRoot(projectPath);
		expect(resolved.root).toBe(projectPath);
		expect(resolved.worktreeId).toBeNull();
	});

	test('denies an unknown root', async () => {
		mockWorktreeByPath.mockReturnValue(null);
		mockGetByPath.mockReturnValue(null);

		expect(() => requireWorkspaceRoot(join(testDir, 'nowhere'))).toThrow('Access denied');
	});
});

describe('resolveFilePath', () => {
	beforeEach(async () => {
		const rawTestDir = join(tmpdir(), `clopen-resolve-path-test-${randomUUID()}`);
		await mkdir(rawTestDir, { recursive: true });
		testDir = await realpath(rawTestDir);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test('follows a symlink to its real location', async () => {
		if (!(await canCreateSymlinks())) {
			console.log('SKIP: symlink creation requires admin on this platform');
			return;
		}
		const projectPath = join(testDir, 'project');
		const externalPath = join(testDir, 'external');
		await mkdir(projectPath, { recursive: true });
		await mkdir(externalPath, { recursive: true });
		await writeFile(join(externalPath, 'notes.txt'), 'content');
		await symlink(externalPath, join(projectPath, 'linked'), 'dir');

		const result = await resolveFilePath(join(projectPath, 'linked', 'notes.txt'));
		expect(result).toBe(join(externalPath, 'notes.txt'));
	});

	test('follows a symlinked parent for a leaf that does not exist yet', async () => {
		if (!(await canCreateSymlinks())) {
			console.log('SKIP: symlink creation requires admin on this platform');
			return;
		}
		// realpath throws for a missing leaf; the symlinked parent must still be
		// resolved so a write lands where it really will.
		const projectPath = join(testDir, 'project');
		const externalPath = join(testDir, 'external');
		await mkdir(projectPath, { recursive: true });
		await mkdir(externalPath, { recursive: true });
		await symlink(externalPath, join(projectPath, 'linked'), 'dir');

		const result = await resolveFilePath(join(projectPath, 'linked', 'new-file.txt'));
		expect(result).toBe(join(externalPath, 'new-file.txt'));
	});

	test('returns a plain path unchanged', async () => {
		const filePath = join(testDir, 'any', 'path', 'file.txt');
		expect(await resolveFilePath(filePath)).toBe(filePath);
	});
});

describe('findContainingProjectId', () => {
	let testDir: string;

	beforeEach(async () => {
		const rawTestDir = join(tmpdir(), `clopen-find-project-test-${randomUUID()}`);
		await mkdir(rawTestDir, { recursive: true });
		testDir = await realpath(rawTestDir);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test('returns the id of the project containing the path', async () => {
		const projectPath = join(testDir, 'project');
		await mkdir(projectPath, { recursive: true });
		mockGetAll.mockReturnValue([{ id: 'proj-1', path: projectPath }]);

		const id = await findContainingProjectId(join(projectPath, 'sub', 'file.txt'));
		expect(id).toBe('proj-1');
	});

	test('returns null when the path is outside every project', async () => {
		const projectPath = join(testDir, 'project');
		await mkdir(projectPath, { recursive: true });
		mockGetAll.mockReturnValue([{ id: 'proj-1', path: projectPath }]);

		const id = await findContainingProjectId(join(testDir, 'outside', 'file.txt'));
		expect(id).toBeNull();
	});

	test('picks the most specific (innermost) project when nested', async () => {
		const outerPath = join(testDir, 'outer');
		const innerPath = join(outerPath, 'inner');
		await mkdir(innerPath, { recursive: true });
		mockGetAll.mockReturnValue([
			{ id: 'outer', path: outerPath },
			{ id: 'inner', path: innerPath },
		]);

		const id = await findContainingProjectId(join(innerPath, 'file.txt'));
		expect(id).toBe('inner');
	});

	test('does not false-match a sibling project sharing a name prefix', async () => {
		const calc2 = join(testDir, 'calc-2');
		const calcPro = join(testDir, 'calc-pro');
		await mkdir(calc2, { recursive: true });
		await mkdir(calcPro, { recursive: true });
		mockGetAll.mockReturnValue([
			{ id: 'calc-2', path: calc2 },
			{ id: 'calc-pro', path: calcPro },
		]);

		const id = await findContainingProjectId(join(calc2, 'image.png'));
		expect(id).toBe('calc-2');
	});
});
