import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description =
	'Remove the structural half of the Memory Graph and keep a memory\'s file paths as an attribute';

/**
 * The code half of the graph is removed, and the paths it existed to anchor
 * become an attribute of the memory itself.
 *
 * Migration 066 stored the codebase as nodes — a node per file, per directory
 * and up to twenty-five per file's symbols — on the argument that a question
 * about code could then travel to the decisions made around it. Measured on a
 * real store, that half was 81% of the nodes (9,053 of 11,159) and 88% of the
 * edges, and it was paying for almost none of what it cost:
 *
 *   - IT NEVER REACHED THE AGENT. `context.ts` drops structural hits before
 *     building the injected block, deliberately: the agent can read the
 *     repository, so spending recall budget to tell it a file exists is worse
 *     than saying nothing.
 *   - IT CROWDED OUT THE MEMORIES. Structural nodes carry no vector (they are
 *     names and paths; embedding them produces a bag of fragments), so they
 *     competed only in BM25 — where they won, because there were four times as
 *     many of them and they match exactly whenever a turn mentions a path.
 *     `RETRIEVAL_DEPTH` had been raised from 18 to 60 purely to leave room for
 *     the episodic hits underneath them.
 *   - MOST OF IT WAS UNREFERENCED. Of 1,920 `about` edges, 1,903 pointed at a
 *     file and 17 at a module. NONE pointed at a symbol — so 4,458 symbol nodes
 *     and their 4,458 `defines` edges were never once the reason a memory was
 *     found.
 *
 * What the half genuinely did was answer one question: WHICH FILES DOES THIS
 * MEMORY CLAIM SOMETHING ABOUT. Structural invalidation needs it (age the
 * memories standing on code that just changed) and so does anchor seeding (a
 * turn that says only "continue" still reaches the memories attached to the file
 * in front of it). That question needs a path, not a node.
 *
 * So paths are demoted from nodes to an attribute, exactly as migration 066
 * already did for entities after canonical entity nodes became half the graph.
 * The lookups get cheaper rather than poorer: invalidation and anchoring are now
 * one index seek into `graph_node_paths` instead of a path → file-node → `about`
 * edge hop, and nothing has to be kept in sync with a parallel node population.
 *
 * `kind` stays on `graph_nodes` as a constant `'episodic'`. It is part of the
 * unique digest index and of the FTS mirror's schema, and rebuilding both across
 * a live memory store to reclaim one constant column would be real risk for no
 * benefit. The application no longer has the concept at all.
 *
 * EVERY STEP HERE IS RE-RUNNABLE, and that is a correctness requirement rather
 * than tidiness. The runner records a migration only after `up` RETURNS, and it
 * wraps nothing in a transaction — so an interrupted run leaves the schema
 * partly changed and the migration still pending. The second run then hits its
 * own output: the backfill reads `graph_nodes.path`, which the first run had
 * already dropped, and the failure is not soft. `initializeDatabase` refuses to
 * start, so the app will not boot again until someone edits the database by
 * hand. Deletes keyed on `kind = 'structural'` are naturally idempotent; the two
 * steps that are not are guarded on whether the old column is still there.
 *
 * There is deliberately NO `VACUUM`. Deleting four fifths of the graph leaves
 * free pages worth reclaiming, but on a real 2.7 GB store the vacuum took around
 * ninety seconds — with the server not yet listening and nothing on screen to
 * explain the wait. A user who gives up and restarts then has two processes
 * racing on one file. The pages are reused as the database grows; reclaiming
 * them is not worth owning that window.
 */
/**
 * Whether a table exists, so this migration can run against a database holding
 * only the graph. The memory tests build one from 066 and this file alone, and
 * both `graph_layout` (067) and `settings` are outside that pair.
 */
function hasTable(db: DatabaseConnection, name: string): boolean {
	const row = db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get(name) as { name: string } | null;
	return row !== null && row !== undefined;
}

/** Whether a column is still present — the test for "has this already run". */
function hasColumn(db: DatabaseConnection, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return rows.some(row => row.name === column);
}

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing the structural half of the memory graph...');

	// ── the paths a memory is about ──────────────────────────────────────────
	// Shaped like `graph_node_entities`: keyed by node, replaced wholesale when
	// extraction re-reads a memory, cascading away with it. `path` is indexed on
	// its own because the hot direction is the reverse one — "these files just
	// changed, which memories claimed something about them".
	db.exec(`
		CREATE TABLE IF NOT EXISTS graph_node_paths (
			node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
			path    TEXT NOT NULL,
			PRIMARY KEY (node_id, path)
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_node_paths_path ON graph_node_paths (path)`);

	// Carry the existing attributions over BEFORE anything is deleted: an `about`
	// edge already records precisely this, it is simply pointing at a node instead
	// of naming a string.
	//
	// Skipped when `path` is already gone, which means an earlier run of this
	// migration got at least this far. Reading it unconditionally is what turned an
	// interrupted run into a database that would not open.
	if (hasColumn(db, 'graph_nodes', 'path')) {
		db.exec(`
			INSERT OR IGNORE INTO graph_node_paths (node_id, path)
			SELECT e.src_id, d.path
			FROM graph_edges e
			INNER JOIN graph_nodes d ON d.id = e.dst_id
			WHERE e.rel = 'about' AND d.kind = 'structural' AND d.path IS NOT NULL AND d.path <> ''
		`);
	}

	const carried = (
		db.prepare(`SELECT COUNT(*) AS c FROM graph_node_paths`).get() as { c: number }
	).c;

	// ── remove the code nodes ────────────────────────────────────────────────
	// The lexical mirror goes first and goes through `fts_rowid`, the way every
	// other delete in this feature does: `graph_nodes_fts.node_id` is UNINDEXED,
	// so matching on it is a full scan of a table that only grows.
	db.exec(`
		DELETE FROM graph_nodes_fts
		WHERE rowid IN (
			SELECT fts_rowid FROM graph_nodes WHERE kind = 'structural' AND fts_rowid IS NOT NULL
		)
	`);
	// Then anything the rowid could not reach — a mirror row whose node was hard
	// deleted at some point without its `fts_rowid` being cleared.
	db.exec(`DELETE FROM graph_nodes_fts WHERE kind = 'structural'`);

	// A memory pointing at a code node as its current belief would be left
	// superseded by something that no longer exists, which hides it from retrieval
	// forever with nothing to explain why. Supersession never crossed the two
	// halves, so this should find nothing — it costs one indexed update to be sure.
	db.exec(`
		UPDATE graph_nodes SET superseded_by = NULL
		WHERE superseded_by IN (SELECT id FROM graph_nodes WHERE kind = 'structural')
	`);

	// Dependent rows are deleted explicitly rather than left to ON DELETE CASCADE.
	// Foreign keys are a per-connection pragma and this codebase does not rely on
	// them being on anywhere else either (see `graphLayoutQueries.pruneOrphans`).
	db.exec(`
		DELETE FROM graph_edges
		WHERE src_id IN (SELECT id FROM graph_nodes WHERE kind = 'structural')
		   OR dst_id IN (SELECT id FROM graph_nodes WHERE kind = 'structural')
	`);
	db.exec(
		`DELETE FROM graph_vectors WHERE node_id IN (SELECT id FROM graph_nodes WHERE kind = 'structural')`
	);
	db.exec(
		`DELETE FROM graph_node_entities WHERE node_id IN (SELECT id FROM graph_nodes WHERE kind = 'structural')`
	);
	// `graph_layout` arrived in a later migration (067) and is derived data that is
	// documented as safe to drop wholesale, so its absence is not an error here.
	if (hasTable(db, 'graph_layout')) {
		db.exec(
			`DELETE FROM graph_layout WHERE node_id IN (SELECT id FROM graph_nodes WHERE kind = 'structural')`
		);
	}

	const removed = (
		db.prepare(`SELECT COUNT(*) AS c FROM graph_nodes WHERE kind = 'structural'`).get() as {
			c: number;
		}
	).c;
	db.exec(`DELETE FROM graph_nodes WHERE kind = 'structural'`);

	// ── drop what only the code half used ────────────────────────────────────
	// The indexes go before the columns: SQLite refuses to drop a column that any
	// index, view or trigger still mentions.
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_path`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_structural_path`);

	// `path`, `symbol` and `language` were only ever written for structural nodes,
	// so every surviving row holds three NULLs. Best-effort: DROP COLUMN needs
	// SQLite 3.35, and a column left behind is dead weight rather than a fault.
	for (const column of ['path', 'symbol', 'language']) {
		if (!hasColumn(db, 'graph_nodes', column)) continue;
		try {
			db.exec(`ALTER TABLE graph_nodes DROP COLUMN ${column}`);
		} catch (error) {
			debug.warn('migration', `Could not drop graph_nodes.${column} (harmless)`, error);
		}
	}

	// "Map the code" is no longer a thing memory can be asked to do.
	if (hasTable(db, 'settings')) {
		db.exec(`DELETE FROM settings WHERE key = 'memory_record_code'`);
	}

	debug.log(
		'migration',
		`Memory graph: ${removed} code node(s) removed, ${carried} path attribution(s) carried over`
	);
};

/**
 * Down restores the SHAPE, not the data.
 *
 * The code half was derived from the disk in the first place — re-running a turn
 * re-observes whatever it described — so there is nothing here worth trying to
 * reconstruct. The columns and indexes come back so an older build can write to
 * the table again; the path attributions stay, because they are the one thing
 * that was not derivable.
 */
export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Restoring the structural columns on the memory graph...');

	for (const column of ['path TEXT', 'symbol TEXT', 'language TEXT']) {
		try {
			db.exec(`ALTER TABLE graph_nodes ADD COLUMN ${column}`);
		} catch (error) {
			debug.warn('migration', `Could not restore graph_nodes.${column} (harmless)`, error);
		}
	}

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_graph_nodes_path ON graph_nodes (COALESCE(project_id, ''), path)`
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_graph_nodes_structural_path ON graph_nodes (project_id, kind, path)`
	);
};
