/**
 * Whether a note collection can be reached.
 *
 * The rule lives here rather than in each route because three call sites need
 * to agree on it — the WebSocket handlers, the image upload, and the image
 * download — and a note whose bytes are reachable through a rule its metadata
 * is not would be worse than no rule at all.
 */

import type { NoteCollection } from '$shared/types/database/schema';
import { projectQueries } from '../database/queries/project-queries';

/**
 * - `project` — reachable while its project is in the workspace list, the same
 *   check the rest of the project-scoped API uses.
 * - `global` — always reachable.
 */
export function canAccessCollection(collection: NoteCollection): boolean {
	if (collection.scope === 'global') return true;
	if (!collection.project_id) return false;
	return projectQueries.isListed(collection.project_id);
}
