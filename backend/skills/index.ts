/**
 * Agent Skills — public facade.
 *
 * The single entry point the rest of the backend imports from. Hides the split
 * between the DB metadata table, the on-disk canonical store, the marketplace
 * providers, and the per-engine sync layer.
 *
 *   - SERVICE (`./service`)     — CRUD used by the WS layer (Settings → Skills).
 *   - MARKETPLACE (`./marketplace`) — browse + install from external providers.
 *   - SYNC (`./sync`)           — materialize enabled skills for each engine,
 *                                 called at stream start by the adapters.
 */

export { skillService } from './service';
export type { SkillDTO, ParsedSkillPreview } from './service';

export { listMarketplaceSkills, fetchMarketplaceSkill } from './marketplace';
export type { MarketplaceSkill, MarketplacePage } from './marketplace';

export { syncSkills, syncSkillsAllEngines, buildSkillsPromptContext } from './sync';
export type { SkillEngine } from './sync';
