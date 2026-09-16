/**
 * Skills Router
 *
 * Entry point for user Agent Skill management (Settings → Skills) — one feature
 * covering model-invoked skills and user-invoked `/slash` prompts:
 *   - skills:list / get / create / update / import / toggle / delete — CRUD
 *   - skills:detect / adopt — on-disk skills, and linking one Clopen doesn't own
 *   - skills:available — the chat "/" picker (the one non-admin route here)
 *   - skills:catalog / install — browse + install from a marketplace provider
 */

import { createRouter } from '$shared/utils/ws-server';
import { skillCrudHandler } from './crud';
import { skillCatalogHandler } from './catalog';

export const skillsRouter = createRouter()
	.merge(skillCrudHandler)
	.merge(skillCatalogHandler);
