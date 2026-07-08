/**
 * Subagents Router — Settings → Subagents CRUD + on-disk detection.
 */

import { createRouter } from '$shared/utils/ws-server';
import { subagentCrudHandler } from './crud';

export const subagentsRouter = createRouter().merge(subagentCrudHandler);
