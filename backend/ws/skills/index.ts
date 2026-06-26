/**
 * Skills Router
 *
 * Entry point for user Agent Skill management (Settings → Skills):
 *   - skills:list / get / create / update / import / toggle / delete — CRUD
 *   - skills:catalog / install — browse + install from a marketplace provider
 */

import { createRouter } from '$shared/utils/ws-server';
import { skillCrudHandler } from './crud';
import { skillCatalogHandler } from './catalog';

export const skillsRouter = createRouter()
	.merge(skillCrudHandler)
	.merge(skillCatalogHandler);
