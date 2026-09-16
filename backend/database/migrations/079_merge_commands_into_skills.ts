import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { DatabaseConnection } from '$shared/types/database/connection';
import { getClopenDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';

export const description = 'Merge commands into skills: one table, one on-disk store, trigger-based invocation';

/**
 * Skills and Commands were two features over one mechanic. Both stored a
 * frontmatter + Markdown document, both synced through `materializeArtifacts`,
 * both were profile-bundled — they differed only in WHO pulls the trigger (the
 * model for a Skill, the user for a Command) and in on-disk shape (folder vs
 * single file).
 *
 * This migration folds Commands into Skills. A skill now carries:
 *   - `triggers`        : comma list of `auto` (model-invoked) and/or `slash`
 *                         (user-invoked as `/<slug>`). Existing skills get
 *                         `auto`; migrated commands get `slash`.
 *   - `argument_hint`   : the old command hint, shown in the "/" picker.
 *   - `uses`            : JSON array of slugs force-loaded when this skill runs.
 *
 * The old per-command `model_by_engine` override is NOT carried across. A skill
 * runs on the session's model whichever way it is invoked; keeping a model pin
 * on the `slash` half only would have made the two triggers behave differently
 * for no reason a user could see.
 *
 * Each `{clopenDir}/commands/<slug>.md` is COPIED to
 * `{clopenDir}/skills/<slug>/SKILL.md`, and `profile_items` rows of type
 * `'command'` are re-typed to `'skill'` under the (possibly de-duped) slug.
 *
 * Copied, not moved, and an existing SKILL.md is never overwritten with an empty
 * body. A command document is prose the user wrote by hand and Clopen holds the
 * only copy of; a migration that deletes the source has exactly one chance to be
 * right, and if it runs against a database whose files aren't beside it — a DB
 * restored from elsewhere, a data dir assembled by hand — it replaces every
 * prompt with nothing and there is no way back. Leaving `commands/` in place
 * costs a stale folder and buys a second chance.
 */

interface LegacyCommandRow {
	id: number;
	slug: string;
	name: string;
	description: string;
	argument_hint: string | null;
	source: string;
	is_enabled: number;
	created_at: string;
}

/** Quote a scalar for YAML output only when it could otherwise be misparsed. */
function quoteIfNeeded(value: string): string {
	if (value === '') return '""';
	if (/[:#"'\n]|^[\s]|[\s]$|^[[{>|&*!%@`]/.test(value)) {
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}
	return value;
}

/** Split a legacy command `.md` into its frontmatter map and body. */
function parseDoc(raw: string): { frontmatter: Record<string, string>; body: string } {
	const text = raw.replace(/^\uFEFF/, '');
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
	if (!match) return { frontmatter: {}, body: text.trim() };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (kv) frontmatter[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
	}
	return { frontmatter, body: (match[2] ?? '').replace(/^\r?\n/, '') };
}

function columnExists(db: DatabaseConnection, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return rows.some(r => r.name === column);
}

function tableExists(db: DatabaseConnection, table: string): boolean {
	const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
	return !!row;
}

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Merging commands into skills...');

	// ── 1. Widen the skills table ──
	const columns: [string, string][] = [
		['triggers', `TEXT NOT NULL DEFAULT 'auto'`],
		['argument_hint', 'TEXT'],
		['uses', `TEXT NOT NULL DEFAULT '[]'`]
	];
	for (const [name, definition] of columns) {
		if (!columnExists(db, 'skills', name)) {
			db.exec(`ALTER TABLE skills ADD COLUMN ${name} ${definition}`);
		}
	}

	if (!tableExists(db, 'commands')) {
		debug.log('migration', 'No commands table — skills widened, nothing to fold');
		return;
	}

	// ── 2. Fold every command row into skills ──
	const commands = db.prepare(`SELECT * FROM commands ORDER BY created_at ASC`).all() as LegacyCommandRow[];
	const skillsRoot = join(getClopenDir(), 'skills');
	const commandsRoot = join(getClopenDir(), 'commands');

	const slugTaken = (slug: string): boolean =>
		!!db.prepare(`SELECT 1 FROM skills WHERE slug = ?`).get(slug);

	for (const command of commands) {
		// A command slug may collide with an existing skill slug — they were
		// separate namespaces until now. Keep both, suffixing the newcomer.
		let slug = command.slug;
		if (slugTaken(slug)) {
			slug = `${command.slug}-command`.slice(0, 64);
			for (let i = 2; slugTaken(slug) && i < 1000; i++) {
				slug = `${command.slug}-command-${i}`.slice(0, 64);
			}
		}

		// Copy the document: `commands/<slug>.md` → `skills/<slug>/SKILL.md`.
		const legacyPath = join(commandsRoot, `${command.slug}.md`);
		const skillMdPath = join(skillsRoot, slug, 'SKILL.md');

		const readBody = (path: string): string => {
			if (!existsSync(path)) return '';
			try {
				return parseDoc(readFileSync(path, 'utf8')).body.trim();
			} catch (error) {
				debug.warn('migration', `Could not read ${path}:`, error);
				return '';
			}
		};

		// Prefer the legacy document; fall back to whatever is already at the
		// destination. The fallback is what makes a second run harmless instead of
		// destructive: without it, a re-run after the source is gone would write an
		// empty body over the one the first run migrated correctly.
		const body = readBody(legacyPath) || readBody(skillMdPath);
		if (!body) {
			debug.warn(
				'migration',
				`Command "${command.slug}" has no body to migrate — ${legacyPath} is missing or empty. ` +
				`The skill is created so it still appears in Settings → Skills, but its instructions must be re-entered.`
			);
		}

		const description = command.description.trim() || command.name.trim() || slug;
		const lines = ['---', `name: ${quoteIfNeeded(slug)}`, `description: ${quoteIfNeeded(description)}`, 'triggers: slash'];
		if (command.argument_hint?.trim()) lines.push(`argument-hint: ${quoteIfNeeded(command.argument_hint.trim())}`);
		lines.push('---');
		const document = `${lines.join('\n')}\n\n${body}\n`;

		try {
			mkdirSync(join(skillsRoot, slug), { recursive: true });
			writeFileSync(skillMdPath, document, 'utf8');
		} catch (error) {
			debug.warn('migration', `Could not write skills/${slug}/SKILL.md:`, error);
		}

		db.prepare(
			`INSERT INTO skills (slug, name, description, source, license, is_enabled, created_at, triggers, argument_hint, uses)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, 'slash', ?, '[]')`
		).run(
			slug,
			command.name,
			description,
			command.source === 'imported' ? 'imported' : 'custom',
			command.is_enabled,
			command.created_at,
			command.argument_hint
		);

		// Re-type profile references so a profile that bundled the command keeps
		// bundling it under its new identity.
		db.prepare(
			`UPDATE profile_items SET artifact_type = 'skill', ref = ? WHERE artifact_type = 'command' AND ref = ?`
		).run(slug, command.slug);
	}

	// Any profile reference to a command that no longer exists is dead weight.
	db.prepare(`DELETE FROM profile_items WHERE artifact_type = 'command'`).run();

	db.exec('DROP TABLE commands');

	// `commandsRoot` is deliberately left on disk. Nothing reads it any more, but
	// it is the user's own writing and the only copy Clopen ever had.
	debug.log('migration', `Folded ${commands.length} command(s) into skills (originals kept in ${commandsRoot})`);
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Splitting slash skills back into a commands table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS commands (
			id             INTEGER  PRIMARY KEY AUTOINCREMENT,
			slug           TEXT     NOT NULL UNIQUE,
			name           TEXT     NOT NULL,
			description    TEXT     NOT NULL DEFAULT '',
			argument_hint  TEXT,
			model          TEXT,
			model_by_engine TEXT    NOT NULL DEFAULT '{}',
			source         TEXT     NOT NULL DEFAULT 'custom',
			is_enabled     INTEGER  NOT NULL DEFAULT 1,
			created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	// Slash-only skills came from commands; move them back. Skills that carry both
	// triggers stay put — they have no pre-merge equivalent.
	db.exec(`
		INSERT INTO commands (slug, name, description, argument_hint, source, is_enabled, created_at)
		SELECT slug, name, description, argument_hint,
		       CASE WHEN source = 'imported' THEN 'imported' ELSE 'custom' END,
		       is_enabled, created_at
		FROM skills WHERE triggers = 'slash'
	`);
	db.exec(`DELETE FROM skills WHERE triggers = 'slash'`);
	// The widened columns are left in place: SQLite cannot drop a column without a
	// table rebuild, and leaving them is harmless for the pre-merge code path.
	debug.log('migration', 'commands table restored');
};
