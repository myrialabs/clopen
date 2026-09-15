/**
 * Who may read and write a note collection.
 *
 * The rule lives here rather than in each route because three call sites need
 * to agree on it — the WebSocket handlers, the image upload, and the image
 * download — and a note whose bytes are reachable through a rule its metadata
 * is not would be worse than no rule at all.
 */

import type { NoteCollection } from '$shared/types/database/schema';
import { projectQueries } from '../database/queries/project-queries';

/**
 * Whether `userId` may see and edit everything in `collection`.
 *
 * - `project` — members of that project, the same check the rest of the
 *   project-scoped API uses.
 * - `global` — every signed-in user on this instance. Global collections are
 *   deliberately instance-wide: there is no per-note ACL, so anything put in
 *   one is readable by every account that can sign in, including members of
 *   unrelated projects.
 */
export function canAccessCollection(userId: string, collection: NoteCollection): boolean {
	if (collection.scope === 'global') return true;
	if (!collection.project_id) return false;
	return projectQueries.userHasProject(userId, collection.project_id);
}
