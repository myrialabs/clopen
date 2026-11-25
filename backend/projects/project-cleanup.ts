/**
 * Default backend cleanup handlers for fully removed projects.
 */
import { disposeProjectEngines } from '../engine';
import { projectContextService } from '../mcp';
import { fileWatcher } from '../files/file-watcher';
import { registerProjectCleanup } from './project-cleanup-registry';
import { removeProjectWorktrees } from '../worktrees';
import { removeProjectNotes } from '../notes/storage';
import { wipeWorkspaceProfile } from '../storage/preview-profiles';

registerProjectCleanup({
	name: 'engine',
	run: (projectId) => disposeProjectEngines(projectId)
});

registerProjectCleanup({
	name: 'mcp-context',
	run: (projectId) => projectContextService.clearByProjectId(projectId)
});

registerProjectCleanup({
	name: 'file-watcher',
	run: (projectId) => {
		fileWatcher.releaseProjectScopes(projectId);
	}
});

// The main tree's Preview Browser profile. Each worktree's profile goes with
// the worktree (see `releaseWorkspaceScope`).
registerProjectCleanup({
	name: 'preview-profile',
	run: async (projectId) => {
		await wipeWorkspaceProfile(projectId);
	}
});

registerProjectCleanup({
	name: 'worktrees',
	run: (projectId) => removeProjectWorktrees(projectId)
});

registerProjectCleanup({
	name: 'notes',
	run: (projectId) => removeProjectNotes(projectId)
});
