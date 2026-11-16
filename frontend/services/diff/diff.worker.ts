/**
 * Diff Worker
 *
 * Runs `diffTasks` off the page's main thread. An exact diff has a worst case
 * no algorithm escapes, and the inputs here can be whole files (conflict
 * previews, the editor gutter on every edit): on the main thread that case
 * froze the tab. Here it only delays one answer, and the pool can drop it by
 * terminating this worker.
 */

import { runDiffJob, type DiffJobRequest } from './diff-tasks';

self.onmessage = (event: MessageEvent<DiffJobRequest>) => {
	self.postMessage(runDiffJob(event.data));
};
