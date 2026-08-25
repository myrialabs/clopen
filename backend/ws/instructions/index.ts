/**
 * Instructions Router — Settings → Instructions (global + per-project blocks).
 */

import { createRouter } from '$shared/utils/ws-server';
import { instructionCrudHandler } from './crud';

export const instructionsRouter = createRouter().merge(instructionCrudHandler);
