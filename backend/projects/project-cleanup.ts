/**
 * Default backend cleanup handlers for fully removed projects.
 */
import { disposeProjectEngines } from '../engine';
import { projectContextService } from '../mcp';
import { fileWatcher } from '../files/file-watcher';
import { registerProjectCleanup } from './project-cleanup-registry';
import { removeProjectWorktrees } from '../worktrees';
import { removeProjectNotes } from '../notes/storage';

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

registerProjectCleanup({
	name: 'worktrees',
	run: (projectId) => removeProjectWorktrees(projectId)
});

registerProjectCleanup({
	name: 'notes',
	run: (projectId) => removeProjectNotes(projectId)
});
