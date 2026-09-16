/**
 * Slash invocation — Clopen expands `/<slug>` itself, before the prompt reaches
 * any engine.
 *
 * This is the whole reason Commands merged into Skills. The old design
 * materialized a command file into each engine's native command directory and
 * relied on the engine to expand it. Only four of the eight engines have such a
 * directory (Claude, Codex, OpenCode, Pi); on the other four the model was handed
 * a list of command NAMES with no bodies and no `$ARGUMENTS` substitution, so
 * `/review-pr 123` produced an invented procedure instead of the user's.
 *
 * Expanding here makes a slash skill behave identically on every engine, and
 * makes `uses:` possible: the composed prompt can deterministically pull in
 * several other skills in one invocation, instead of hoping the model notices
 * they are relevant.
 *
 * Argument substitution follows the convention users already know from Claude's
 * custom commands:
 *   - `$ARGUMENTS` — everything typed after the slug;
 *   - `$1` … `$9`  — individual whitespace-separated arguments;
 * and when a body references neither, the arguments are appended under a short
 * heading so they are never silently dropped.
 */

import { skillQueries, parseTriggers, parseUses } from '$backend/database/queries';
import { artifactFilter } from '$backend/profiles';
import { debug } from '$shared/utils/logger';
import { parseSkillMd } from './spec';
import { getSkillMdPath, getSkillDir, readSkillMd } from './store';

/** A `/slug args…` message, split into its parts. */
export interface SlashInvocation {
	slug: string;
	args: string;
}

/** The result of expanding a slash invocation. */
export interface ExpandedInvocation {
	slug: string;
	name: string;
	/** The prompt text to send to the engine in place of the user's `/slug` line. */
	text: string;
	/** Slugs force-loaded through `uses:` (transitively resolved, in load order). */
	used: string[];
}

/** What the caller knows about the stream the invocation belongs to. */
export interface InvocationContext {
	profileId?: number | null;
}

/**
 * Anything that is not a lone `/word …` line is a normal message. The slug
 * pattern deliberately matches the skill slug grammar, so a path like `/usr/bin`
 * or a lone `/` never looks like an invocation.
 */
const SLASH_RE = /^[ \t]*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:[ \t]+([\s\S]*))?$/;

/** Parse a raw message into a slash invocation, or null when it isn't one. */
export function parseSlashInvocation(text: string): SlashInvocation | null {
	const match = SLASH_RE.exec(text.replace(/\s+$/, ''));
	if (!match) return null;
	return { slug: match[1], args: (match[2] ?? '').trim() };
}

/** Split an argument string the way a shell-ish `$1 $2` substitution expects. */
function splitArgs(args: string): string[] {
	return args.length ? args.split(/\s+/) : [];
}

/**
 * Substitute `$ARGUMENTS` / `$1`…`$9` into a body. Returns the substituted text
 * plus whether any placeholder was actually present, so the caller can decide to
 * append unconsumed arguments rather than drop them.
 *
 * Exported for direct testing: this is the contract users rely on when porting a
 * `.claude/commands/*.md`, and it is the one part of expansion that has to be
 * right without a database or an engine in the loop.
 */
export function substituteArgs(body: string, args: string): { text: string; consumed: boolean } {
	const positional = splitArgs(args);
	let consumed = false;
	const text = body
		.replace(/\$ARGUMENTS\b/g, () => {
			consumed = true;
			return args;
		})
		.replace(/\$([1-9])\b/g, (_match, index: string) => {
			consumed = true;
			return positional[Number(index) - 1] ?? '';
		});
	return { text, consumed };
}

/**
 * The skills that may be invoked by slug for this stream: the enabled set, or
 * exactly the active Profile's set when it references any skill (same
 * presence-per-type rule the sync path uses — a profile-referenced skill counts
 * even if globally disabled).
 */
function invocableSlugs(profileId?: number | null): Set<string> {
	const filter = artifactFilter(profileId ?? undefined, 'skill');
	const rows = filter ? skillQueries.getAll().filter(r => filter.has(r.slug)) : skillQueries.getEnabled();
	return new Set(rows.map(r => r.slug));
}

/**
 * Resolve `uses:` transitively, breadth-first, skipping anything not currently
 * invocable. A skill that lists itself (directly or through a cycle) is visited
 * once — a cycle must not hang or duplicate the load list.
 */
function resolveUses(rootSlug: string, allowed: Set<string>): string[] {
	const seen = new Set<string>([rootSlug]);
	const ordered: string[] = [];
	const queue = [...parseUses(skillQueries.getBySlug(rootSlug)?.uses)];
	while (queue.length > 0) {
		const slug = queue.shift()!;
		if (seen.has(slug)) continue;
		seen.add(slug);
		const row = skillQueries.getBySlug(slug);
		if (!row) {
			debug.warn('skills', `⚠️ Skill "${rootSlug}" uses "${slug}", which does not exist — skipping`);
			continue;
		}
		if (!allowed.has(slug)) {
			debug.warn('skills', `⚠️ Skill "${rootSlug}" uses "${slug}", which is disabled or out of profile — skipping`);
			continue;
		}
		ordered.push(slug);
		queue.push(...parseUses(row.uses));
	}
	return ordered;
}

/**
 * Build the block that force-loads the `uses:` skills. Paths, not inlined
 * bodies: every engine has a file-reading tool, the bundled `scripts/` and
 * `references/` beside each SKILL.md stay reachable, and a chain of skills
 * doesn't blow up the prompt.
 */
function buildUsesBlock(used: { slug: string; name: string; description: string }[]): string {
	if (used.length === 0) return '';
	const lines = [
		'# Required skills',
		'',
		'Before doing anything else, read each of these SKILL.md files with your',
		'file-reading tool and follow them for this task. They are required, not',
		'suggestions — do not skip one because the task looks simple.',
		''
	];
	for (const skill of used) {
		lines.push(`- **${skill.name}** — ${skill.description}`);
		lines.push(`  Instructions: ${getSkillMdPath(skill.slug)}`);
	}
	return lines.join('\n');
}

/**
 * Expand a `/slug args…` message into the prompt the engine should actually
 * receive. Returns null when the text is not a slash invocation, or names a slug
 * that isn't an invocable slash skill for this stream — in both cases the
 * message must be sent through untouched (the user may simply have typed a line
 * starting with a slash).
 *
 * Never throws: a skill whose SKILL.md has gone missing on disk falls back to
 * "not an invocation" rather than breaking the turn.
 */
export async function expandSlashInvocation(
	text: string,
	context: InvocationContext
): Promise<ExpandedInvocation | null> {
	const invocation = parseSlashInvocation(text);
	if (!invocation) return null;

	const row = skillQueries.getBySlug(invocation.slug);
	if (!row || !parseTriggers(row.triggers).includes('slash')) return null;

	const allowed = invocableSlugs(context.profileId);
	if (!allowed.has(row.slug)) return null;

	let body: string;
	try {
		const raw = await readSkillMd(row.slug);
		if (raw == null) {
			debug.warn('skills', `⚠️ /${row.slug} invoked but SKILL.md is missing on disk — sending the message as typed`);
			return null;
		}
		body = parseSkillMd(raw).body;
	} catch (error) {
		debug.warn('skills', `⚠️ Could not read SKILL.md for /${row.slug} — sending the message as typed:`, error);
		return null;
	}

	const { text: substituted, consumed } = substituteArgs(body, invocation.args);
	const usedSlugs = resolveUses(row.slug, allowed);
	const used = usedSlugs
		.map(slug => skillQueries.getBySlug(slug))
		.filter((r): r is NonNullable<typeof r> => r !== null)
		.map(r => ({ slug: r.slug, name: r.name, description: r.description }));

	const sections = [buildUsesBlock(used), substituted.trim()];
	// Arguments the body never referenced would otherwise vanish — the user typed
	// them for a reason, so hand them to the model explicitly.
	if (invocation.args && !consumed) {
		sections.push(`# Arguments\n\n${invocation.args}`);
	}
	// The skill's own folder is where its bundled resources live; say so once so
	// `scripts/`-style references in the body resolve without guessing.
	sections.push(`(Invoked as /${row.slug}. Skill files: ${getSkillDir(row.slug)})`);

	debug.log(
		'skills',
		`⌨️ Expanded /${row.slug}${invocation.args ? ' with arguments' : ''}${used.length ? `, requiring ${used.length} skill(s)` : ''}`
	);

	return {
		slug: row.slug,
		name: row.name,
		text: sections.filter(Boolean).join('\n\n'),
		used: usedSlugs
	};
}
