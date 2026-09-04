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
const mockGetAllForUser = mock(() => [] as Array<{ id: string; path: string }>);
const mockGetAll = mock(() => [] as Array<{ id: string; path: string }>);
const mockUserHasProject = mock(() => false);
const mockGetByPath = mock(() => null as { id: string; path: string } | null);
const mockGetById = mock(() => null as { id: string; path: string } | null);

mock.module('../../database/queries/project-queries', () => ({
	projectQueries: {
		getAllForUser: mockGetAllForUser,
		getAll: mockGetAll,
		userHasProject: mockUserHasProject,
		getByPath: mockGetByPath,
		getById: mockGetById,
	}
}));

// A project's accessible area now includes its worktrees, so the lookup is part
// of the data layer this test models.
const mockWorktreesByProject = mock(() => [] as Array<{ id: string; path: string }>);
const mockWorktreeByPath = mock(() => null as { id: string; project_id: string; path: string } | null);

mock.module('../../database/queries/worktree-queries', () => ({
	worktreeQueries: {
		getByProjectId: mockWorktreesByProject,
		getByPath: mockWorktreeByPath,
	}
}));

const mockGetRole = mock((): 'admin' | 'member' => 'member');
const mockGetUserId = mock(() => 'user-1');

mock.module('$backend/utils/ws', () => ({
	ws: {
		getRole: mockGetRole,
		getUserId: mockGetUserId,
	}
}));

mock.module('../access', () => ({
	requireProjectAccess: mock(() => ({ id: 'proj-1', path: '' })),
}));

// Import after mocking
const { requireFilePathAccess, requireSharedFilePathAccess, findContainingProjectId, resolveProjectForRoot, requireWorkspaceRootAccess } = await import('./path-access');

let testDir: string;

describe('path-access symlink resolution', () => {
	beforeEach(async () => {
		const rawTestDir = join(tmpdir(), `clopen-path-access-test-${randomUUID()}`);
		await mkdir(rawTestDir, { recursive: true });
		// Canonicalize so test expectations match what resolveRealPath returns.
		// macOS tmpdir lives under /var → /private/var, which realpath follows.
		testDir = await realpath(rawTestDir);
		mockGetRole.mockImplementation(() => 'member');
		mockGetUserId.mockImplementation(() => 'user-1');
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		mockWorktreesByProject.mockReturnValue([]);
		mockWorktreeByPath.mockReturnValue(null);
	});

	test('allows a path inside a worktree of an accessible project', async () => {
		const projectPath = join(testDir, 'project');
		const worktreePath = join(testDir, 'worktrees', 'feature');
		await mkdir(projectPath, { recursive: true });
		await mkdir(worktreePath, { recursive: true });
		await writeFile(join(worktreePath, 'index.ts'), 'export {};');

		mockGetAllForUser.mockReturnValue([{ id: 'proj-1', path: projectPath }]);
		mockWorktreesByProject.mockReturnValue([{ id: 'wt-1', path: worktreePath }]);

		const target = join(worktreePath, 'index.ts');
		await expect(requireFilePathAccess({} as any, target)).resolves.toBe(target);
	});

	test('still denies a worktree of a project the user cannot access', async () => {
		const worktreePath = join(testDir, 'worktrees', 'other');
		await mkdir(worktreePath, { recursive: true });
		await writeFile(join(worktreePath, 'secret.txt'), 'nope');

		mockGetAllForUser.mockReturnValue([]);
		mockWorktreesByProject.mockReturnValue([{ id: 'wt-1', path: worktreePath }]);

		await expect(
			requireFilePathAccess({} as any, join(worktreePath, 'secret.txt'))
		).rejects.toThrow('Access denied');
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
		mockGetRole.mockImplementation(() => 'admin');

		const resolved = requireWorkspaceRootAccess({} as any, worktreePath);
		expect(resolved.root).toBe(worktreePath);
		expect(resolved.worktreeId).toBe('wt-1');
		expect(resolved.project.id).toBe('proj-1');
	});

	test('returns the project root for the main tree', async () => {
		const projectPath = join(testDir, 'project');

		mockWorktreeByPath.mockReturnValue(null);
		mockGetByPath.mockReturnValue({ id: 'proj-1', path: projectPath });
		mockGetRole.mockImplementation(() => 'admin');

		const resolved = requireWorkspaceRootAccess({} as any, projectPath);
		expect(resolved.root).toBe(projectPath);
		expect(resolved.worktreeId).toBeNull();
	});

	test('denies an unknown root', async () => {
		mockWorktreeByPath.mockReturnValue(null);
		mockGetByPath.mockReturnValue(null);
		mockGetRole.mockImplementation(() => 'admin');

		expect(() => requireWorkspaceRootAccess({} as any, join(testDir, 'nowhere'))).toThrow(
			'Access denied'
		);
	});

	test('blocks read through symlink to external directory', async () => {
		if (!(await canCreateSymlinks())) {
			console.log('SKIP: symlink creation requires admin on this platform');
			return;
		}
		// Setup: project at testDir/project, symlink pointing to testDir/external
		const projectPath = join(testDir, 'project');
		const externalPath = join(testDir, 'external');
		const symlinkPath = join(projectPath, 'escape');

		await mkdir(projectPath, { recursive: true });
		await mkdir(externalPath, { recursive: true });
		await writeFile(join(externalPath, 'secret.txt'), 'confidential');
		await symlink(externalPath, symlinkPath, 'dir');

		mockGetAllForUser.mockReturnValue([{ id: 'proj-1', path: projectPath }]);

		// Attempt to access file through symlink
		const targetPath = join(symlinkPath, 'secret.txt');
		await expect(requireFilePathAccess({} as any, targetPath)).rejects.toThrow('Access denied');
	});

	test('blocks write through symlink to external directory for non-existing leaf', async () => {
		if (!(await canCreateSymlinks())) {
			console.log('SKIP: symlink creation requires admin on this platform');
			return;
		}
		// Setup: project at testDir/project, symlink pointing to testDir/external
		const projectPath = join(testDir, 'project');
		const externalPath = join(testDir, 'external');
		const symlinkPath = join(projectPath, 'escape');

		await mkdir(projectPath, { recursive: true });
		await mkdir(externalPath, { recursive: true });
		await symlink(externalPath, symlinkPath, 'dir');

		mockGetAllForUser.mockReturnValue([{ id: 'proj-1', path: projectPath }]);

		// Attempt to write to a non-existing file through symlink
		// This is the key regression: realpath throws for non-existing paths,
		// but resolveRealPath should still resolve the symlinked parent
		const targetPath = join(symlinkPath, 'new-file.txt');
		await expect(requireFilePathAccess({} as any, targetPath)).rejects.toThrow('Access denied');
	});

	test('blocks rename of ancestor path containing another user project', async () => {
		// Setup: user-1 tries to rename /parent, but user-2 has project at /parent/child
		const parentPath = join(testDir, 'parent');
		const childProjectPath = join(parentPath, 'child-project');

		await mkdir(childProjectPath, { recursive: true });

		mockGetAll.mockReturnValue([{ id: 'proj-2', path: childProjectPath }]);
		mockUserHasProject.mockReturnValue(false);

		// user-1 attempts to rename the parent directory
		await expect(requireSharedFilePathAccess({} as any, parentPath)).rejects.toThrow('Access denied');
	});

	test('allows access to files inside user own project', async () => {
		const projectPath = join(testDir, 'project');
		const filePath = join(projectPath, 'file.txt');

		await mkdir(projectPath, { recursive: true });
		await writeFile(filePath, 'content');

		mockGetAllForUser.mockReturnValue([{ id: 'proj-1', path: projectPath }]);

		const result = await requireFilePathAccess({} as any, filePath);
		expect(result).toBe(filePath);
	});

	test('allows creating new files inside user own project', async () => {
		const projectPath = join(testDir, 'project');
		const newFilePath = join(projectPath, 'new-file.txt');

		await mkdir(projectPath, { recursive: true });

		mockGetAllForUser.mockReturnValue([{ id: 'proj-1', path: projectPath }]);

		// new-file.txt doesn't exist yet, but should still be allowed
		const result = await requireFilePathAccess({} as any, newFilePath);
		expect(result).toBe(newFilePath);
	});

	test('admin bypasses all checks', async () => {
		mockGetRole.mockImplementation(() => 'admin');

		const anyPath = join(testDir, 'any', 'path', 'file.txt');
		const result = await requireFilePathAccess({} as any, anyPath);
		expect(result).toBe(anyPath);
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
