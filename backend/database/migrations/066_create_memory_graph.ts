import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description =
	'Create the Memory Graph: nodes, edges, vectors, entity index, the FTS5 mirror and the extraction queue';

/**
 * The Memory Graph holds two kinds of memory in ONE store so they can reference
 * each other:
 *
 *   - `episodic`   — decisions, patterns, failures, preferences, observations
 *                    carried over from past work, whichever engine produced it.
 *   - `structural` — the codebase as entities: files, symbols, modules and the
 *                    dependencies between them.
 *
 * The join between them is an edge (`rel = 'about'`), which is what makes this a
 * single graph rather than two systems sharing a database. Asking "what touches
 * module Y" then also surfaces the decisions made around it, and asking "what
 * did we decide about X" surfaces the code it applies to.
 *
 * `project_id` is provenance, not a fence: there is one graph for the whole
 * instance and edges may cross projects. Whether a memory travels is `reach`,
 * decided per memory — which is what lets a Svelte gotcha found in one repository
 * be recalled in another, and is the foundation the cross-project global chat is
 * built on. Queries narrow by reach; the storage never partitions.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating memory graph tables...');

	// ── nodes ────────────────────────────────────────────────────────────────
	// Three groups of columns, and it is worth knowing which is which:
	//
	// IDENTITY — `digest` is the dedupe key: a stable hash of what identifies the
	//   node (repo-relative path for a file, normalised claim for a memory).
	//   Extraction runs on every turn and would otherwise re-add the same memory
	//   endlessly, so writes upsert on it rather than insert blindly.
	//   `digest_version` records which algorithm produced it, so a changed basis
	//   can be re-derived deliberately instead of silently forking the graph into
	//   duplicates. `entity_key` gives entity-shaped nodes a canonical identity.
	//
	// STANDING — `weight` is reinforcement; `access_count`/`accessed_at` feed
	//   retrieval decay. `useful_count`/`unhelpful_count` are the closed loop:
	//   access only records that a memory was RETRIEVED, which is not evidence of
	//   anything and feeds back into its own ranking, while these record what the
	//   next turn actually did with it. `pinned` exempts a node from decay and
	//   from automatic pruning.
	//
	// AUTHORITY AND REACH — deliberately four columns rather than two, because
	//   collapsing them is what produced the worst bugs this feature had:
	//     `source`      — which write path wrote this: hand-written through the
	//                     composer, or not.
	//     `asserted_by` — whose claim it is: `user` (they said it), `assistant`
	//                     (it asserted it) or `inferred` (a model concluded it).
	//                     Kept apart from `source` so an agent's inference can
	//                     never retire something a person typed by hand.
	//     `reach`       — `here` for a claim about this codebase, `anywhere` for a
	//                     claim about a language, runtime, library or practice
	//                     that someone on a different project would want. Kept
	//                     apart from `project_id` so provenance stops acting as a
	//                     filter.
	//     `reach_judged`— whether a model has classified the reach yet, so
	//                     "judged to be local" is distinguishable from "nobody has
	//                     looked" and the maintenance pass only revisits the
	//                     second group.
	//
	// LIFECYCLE — `superseded_by` is belief revision: the node stays (its edges
	//   explain how the current belief was reached) but leaves retrieval, so an
	//   agent is never handed two versions of one fact. `stale_at` is structural
	//   invalidation, set when code a memory is `about` changed underneath it.
	//   `archived_at` soft-deletes, so a wrong memory can be dismissed without
	//   losing the edges that explain how it was reached.
	//
	// `fts_rowid` points at this node's row in the FTS mirror; see the mirror's
	// own note below for why it is not optional.
	db.exec(`
		CREATE TABLE IF NOT EXISTS graph_nodes (
			id              TEXT     PRIMARY KEY,
			kind            TEXT     NOT NULL,
			subkind         TEXT     NOT NULL,
			scope           TEXT     NOT NULL DEFAULT 'project',
			project_id      TEXT,
			session_id      TEXT,
			label           TEXT     NOT NULL,
			body            TEXT     NOT NULL DEFAULT '',
			path            TEXT,
			symbol          TEXT,
			language        TEXT,
			digest          TEXT     NOT NULL,
			-- Callers always supply the current DIGEST_VERSION explicitly; the
			-- default exists only so the column can be NOT NULL.
			digest_version  INTEGER  NOT NULL DEFAULT 1,
			entity_key      TEXT,
			confidence      REAL     NOT NULL DEFAULT 0.5,
			weight          REAL     NOT NULL DEFAULT 1.0,
			access_count    INTEGER  NOT NULL DEFAULT 0,
			useful_count    INTEGER  NOT NULL DEFAULT 0,
			unhelpful_count INTEGER  NOT NULL DEFAULT 0,
			source          TEXT     NOT NULL DEFAULT 'agent',
			asserted_by     TEXT     NOT NULL DEFAULT 'inferred',
			reach           TEXT     NOT NULL DEFAULT 'here',
			reach_judged    INTEGER  NOT NULL DEFAULT 0,
			pinned          INTEGER  NOT NULL DEFAULT 0,
			superseded_by   TEXT     REFERENCES graph_nodes(id) ON DELETE SET NULL,
			stale_at        DATETIME,
			archived_at     DATETIME,
			fts_rowid       INTEGER,
			created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
			accessed_at     DATETIME
		)
	`);

	// SQLite treats every NULL as distinct in a UNIQUE index, so global-scope
	// rows (project_id IS NULL) would never de-duplicate under a plain UNIQUE.
	// Key on a COALESCE expression the way permission_sets (049) does.
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_digest
		ON graph_nodes (COALESCE(project_id, ''), kind, digest)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes (project_id, kind)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_scope ON graph_nodes (scope, kind)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_session ON graph_nodes (session_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_path ON graph_nodes (COALESCE(project_id, ''), path)`);

	// One canonical node per entity key, per project, shaped like the digest index
	// so a project-local entity is still possible.
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_entity
		ON graph_nodes (COALESCE(project_id, ''), entity_key)
		WHERE entity_key IS NOT NULL
	`);

	// Retrieval filters on "is this still the current belief" on every query, in
	// both channels, so it needs to be cheap.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_current ON graph_nodes (superseded_by, archived_at)`);
	// Retention scans by age and by how little a node has earned its place.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_retention ON graph_nodes (source, pinned, archived_at)`);

	// The scans that run on a timer. Partial indexes, because every one of them
	// only ever looks at live rows and stays small however much history piles up.
	//
	// The vector backfill's driving query: live episodic nodes, newest first.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_graph_nodes_live_episodic
		ON graph_nodes (kind, updated_at DESC)
		WHERE archived_at IS NULL AND superseded_by IS NULL
	`);
	// Eviction scans by age over model-written, unpinned, never-useful rows.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_graph_nodes_evictable
		ON graph_nodes (source, pinned, useful_count, access_count, updated_at)
		WHERE archived_at IS NULL AND superseded_by IS NULL
	`);
	// Standing instructions: a query-independent lookup that runs on every turn,
	// so it must be an index seek rather than a scan of the episodic half.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_graph_nodes_standing
		ON graph_nodes (asserted_by, subkind, project_id)
		WHERE kind = 'episodic' AND archived_at IS NULL AND superseded_by IS NULL
	`);
	// Cross-project recall filters on reach before anything else.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_graph_nodes_reach
		ON graph_nodes (reach, kind)
		WHERE archived_at IS NULL AND superseded_by IS NULL
	`);
	// The reclassification pass looks for what has not been judged.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_graph_nodes_reach_pending
		ON graph_nodes (reach_judged, kind)
		WHERE archived_at IS NULL AND superseded_by IS NULL
	`);
	// The Forgotten list, which is the only view that reads archived rows.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_archived ON graph_nodes (archived_at)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_superseded ON graph_nodes (superseded_by)`);
	// Structural retirement walks path-keyed rows per project.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_structural_path ON graph_nodes (project_id, kind, path)`);

	// ── edges ────────────────────────────────────────────────────────────────
	// Relations, grouped by what they connect:
	//   structural ↔ structural : imports | calls | defines | contains
	//   episodic   ↔ episodic   : caused_by | supersedes | contradicts | generalizes
	//   episodic   → structural : about        ← the bridge between both halves
	//   any        ↔ any        : relates_to   (user-drawn, no semantics implied)
	//
	// `relates_to` is USER-DRAWN ONLY. An automatic similarity linker used to
	// write it from vector neighbourhoods and it fabricated most of the graph:
	// against a corpus of eighty sentences all shaped "X is a project that does
	// Y", every pair is similar in SHAPE rather than in SUBJECT, so 144 of 371
	// edges were pairings like "Vantum monorepo phase 1.8" ↔ "ChatKit runs on
	// Node.js 18+". Connecting statements that share a subject is what the entity
	// index below does directly and exactly; nothing infers `relates_to` now.
	//
	// Direction is meaningful for every relation except `relates_to`. Both ends
	// cascade so archiving/removing a node cannot leave dangling edges.
	db.exec(`
		CREATE TABLE IF NOT EXISTS graph_edges (
			id         INTEGER  PRIMARY KEY AUTOINCREMENT,
			src_id     TEXT     NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
			dst_id     TEXT     NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
			rel        TEXT     NOT NULL,
			weight     REAL     NOT NULL DEFAULT 1.0,
			source     TEXT     NOT NULL DEFAULT 'agent',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_unique ON graph_edges (src_id, dst_id, rel)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges (src_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges (dst_id)`);
	// `edgesOf` / invalidation filter by relation far more often than not.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_rel ON graph_edges (rel)`);
	// `contradicts` is walked for every candidate on the read path.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_contradicts ON graph_edges (rel, src_id, dst_id)`);

	// ── entities ─────────────────────────────────────────────────────────────
	// The subjects a memory is about ("Bun", "PostgreSQL", "Myria Labs"), so five
	// statements about one subject converge on one place instead of being five
	// islands.
	//
	// An ATTRIBUTE of the memory, not a node of its own. Canonical entity nodes
	// were tried first and became half the graph: 115 of 208 episodic nodes were
	// name-only stubs with an empty body, `about` pointed at a stub 220 times and
	// at a file 6, and an empty body means no vector — so a stub could never be
	// found semantically while still being offered to the model as something to
	// adjudicate against. A name is not a claim; it cannot agree or disagree with
	// one. As rows here, joined into the FTS text below, "what do we know about
	// Bun" is an index lookup instead of a graph hop.
	db.exec(`
		CREATE TABLE IF NOT EXISTS graph_node_entities (
			node_id    TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
			entity_key TEXT NOT NULL,
			name       TEXT NOT NULL,
			PRIMARY KEY (node_id, entity_key)
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_node_entities_key ON graph_node_entities (entity_key)`);

	// ── vectors ──────────────────────────────────────────────────────────────
	// One int8-quantized vector per node (float32 scale + int8 components, 260
	// bytes at 256 dims) produced by the local embedder. `model` records which
	// artifact version wrote it so swapping the model invalidates stale vectors
	// instead of silently mixing two embedding spaces.
	db.exec(`
		CREATE TABLE IF NOT EXISTS graph_vectors (
			node_id    TEXT     PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
			dim        INTEGER  NOT NULL,
			model      TEXT     NOT NULL,
			vec        BLOB     NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_vectors_model ON graph_vectors (model)`);

	// ── lexical index ────────────────────────────────────────────────────────
	// BM25 is not a fallback for the vector search — both run on every query and
	// their rankings are fused (see backend/memory/retrieval.ts). Lexical is what
	// finds identifiers, paths and error names, which embeddings are weakest at.
	//
	// A standalone table (not `content=graph_nodes`) because the indexed text is
	// derived from several columns, matching the choice made for messages_fts (064).
	//
	// `node_id` is UNINDEXED, which is why `graph_nodes.fts_rowid` exists: without
	// it, the `DELETE ... WHERE node_id = ?` that every upsert performs is a full
	// scan of the FTS content table. One busy turn upserts a file node, a module
	// node and up to twenty-five symbol nodes for each of sixty files — roughly
	// fifteen hundred full scans of a table that only grows. Keeping the rowid on
	// the node turns each of those into a primary-key lookup.
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
			node_id UNINDEXED,
			project_id UNINDEXED,
			scope UNINDEXED,
			kind UNINDEXED,
			text
		)
	`);

	// ── extraction queue ─────────────────────────────────────────────────────
	// Where a finished turn waits to be summarised.
	//
	// A table rather than an in-memory map, because a map lost turns three ways
	// silently: a failed model call (rate limited, account expired, engine
	// restarting, no model configured) was logged and dropped with no second
	// attempt ever; a restart discarded everything parked; and none of it was
	// visible, so memory simply did not grow and the only way to find out why was
	// to read the server log. Rows survive a crash, a failure schedules a retry
	// with backoff, and the queue is countable — the UI can say "3 waiting, 1
	// retrying" instead of leaving the user to guess.
	//
	// ONE ROW PER SESSION, enforced by the unique index. That is not just
	// deduplication — it IS the "bank the oldest boundary" rule from the scheduler
	// expressed in the schema: a new turn in a session already queued merges into
	// the existing row and keeps its `user_message_id`, because the transcript runs
	// from that message to the end of the chain and the older boundary is the one
	// that covers everything since.
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_extraction_queue (
			id           INTEGER  PRIMARY KEY AUTOINCREMENT,
			session_id   TEXT     NOT NULL,
			project_id   TEXT     NOT NULL,
			project_path TEXT     NOT NULL,
			-- The OLDEST turn boundary not yet summarised; see the note above.
			user_message_id TEXT  NOT NULL,
			-- JSON arrays. Accumulated across every turn merged into this row.
			changed_paths TEXT    NOT NULL DEFAULT '[]',
			deleted_paths TEXT    NOT NULL DEFAULT '[]',
			-- Memories injected into those turns, so the extraction can adjudicate them.
			injected_ids  TEXT    NOT NULL DEFAULT '[]',
			attempts     INTEGER  NOT NULL DEFAULT 0,
			last_error   TEXT,
			-- pending: will run once ready_at passes. failed: attempts exhausted,
			-- kept so it stays visible and can be retried deliberately.
			status       TEXT     NOT NULL DEFAULT 'pending',
			-- Bumped on every merge. Extraction runs the moment a turn ends, so a
			-- turn can finish while the previous one is still being summarised and
			-- enqueueing merges into the row already in flight — whose runner would
			-- then delete it on success, taking the merged-in turn with it. The
			-- runner remembers the revision it claimed and its delete is conditional
			-- on the row still being at it.
			revision     INTEGER  NOT NULL DEFAULT 0,
			-- The idle delay and the retry backoff are both expressed here, so the
			-- runner only ever asks "what is due?".
			ready_at     DATETIME NOT NULL,
			created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_queue_session ON memory_extraction_queue (session_id)`);
	// The runner's only hot query: due rows, oldest first.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_queue_due ON memory_extraction_queue (status, ready_at)`);

	debug.log('migration', 'Memory graph tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping memory graph tables...');
	db.exec(`DROP INDEX IF EXISTS idx_memory_queue_due`);
	db.exec(`DROP INDEX IF EXISTS idx_memory_queue_session`);
	db.exec(`DROP TABLE IF EXISTS memory_extraction_queue`);
	db.exec(`DROP TABLE IF EXISTS graph_nodes_fts`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_vectors_model`);
	db.exec(`DROP TABLE IF EXISTS graph_vectors`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_node_entities_key`);
	db.exec(`DROP TABLE IF EXISTS graph_node_entities`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_edges_contradicts`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_edges_rel`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_edges_dst`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_edges_src`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_edges_unique`);
	db.exec(`DROP TABLE IF EXISTS graph_edges`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_structural_path`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_superseded`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_archived`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_reach_pending`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_reach`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_standing`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_evictable`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_live_episodic`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_retention`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_current`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_entity`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_path`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_session`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_scope`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_project`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_digest`);
	db.exec(`DROP TABLE IF EXISTS graph_nodes`);
	debug.log('migration', 'Memory graph tables dropped');
};
