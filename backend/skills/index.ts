/**
 * Agent Skills — public facade.
 *
 * The single entry point the rest of the backend imports from. Hides the split
 * between the DB metadata table, the on-disk canonical store, the marketplace
 * providers, the slash-invocation expander, and the per-engine sync layer.
 *
 * Since migration 079 this module owns what used to be two features: a skill is
 * invoked by the MODEL (`auto` trigger, advertised through its description) or
 * by the USER (`slash` trigger, typed as `/<slug>` and expanded here), or both.
 *
 *   - SERVICE (`./service`)     — CRUD used by the WS layer (Settings → Skills).
 *   - INVOKE (`./invoke`)       — expand `/<slug> args` into the engine prompt.
 *   - MARKETPLACE (`./marketplace`) — browse + install from external providers.
 *   - DETECT (`./detect`)       — on-disk skills, managed and adoptable.
 *   - SYNC (`./sync`)           — materialize active skills for each engine,
 *                                 called at stream start by the adapters.
 */

export { skillService } from './service';
export type { SkillDTO, SkillInputFields, ParsedSkillPreview, AvailableSkill } from './service';

export { expandSlashInvocation, parseSlashInvocation } from './invoke';
export type { ExpandedInvocation, SlashInvocation, InvocationContext } from './invoke';

export { listMarketplaceSkills, fetchMarketplaceSkill } from './marketplace';
export type { MarketplaceSkill, MarketplacePage } from './marketplace';

export { detectSkills } from './detect';
export type { DetectedSkillGroup } from './detect';

export {
	syncSkills,
	syncSkillsAllEngines,
	buildSkillsPromptContext,
	stripLegacyCommandArtifacts,
	skillFileReady
} from './sync';
export type { SkillEngine } from './sync';
