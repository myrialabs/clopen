import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description =
	'Persist memory-graph communities and layout positions, and index the graph view ordering';

/**
 * Make the Memory view stop paying for the whole graph on every look.
 *
 * Two things used to be recomputed from scratch on every single fetch, and both
 * of them grow with the store rather than with what is being displayed:
 *
 *   - COMMUNITY DETECTION. Louvain ran inside `buildGraphView`, so opening the
 *     modal, changing a filter, or any conversation writing a memory made every
 *     connected client re-cluster the graph server-side. The result is stable
 *     per dataset, so it belonged in a table all along.
 *
 *   - LAYOUT. ForceAtlas2 ran in the browser on every open, from a deterministic
 *     seed — several hundred iterations to arrive at the same arrangement it
 *     arrived at last time, discarded the moment the modal closed. That is what
 *     made opening the modal janky once the graph got big: the animation and a
 *     few hundred milliseconds of layout were competing for one thread.
 *
 * `graph_layout` holds both, keyed by node. It is deliberately a SEPARATE table
 * rather than columns on `graph_nodes`: a position is a property of an
 * arrangement, not of a memory, so a re-layout must never look like an edit to
 * the memory itself — `updated_at` on `graph_nodes` drives recall ranking, and
 * bumping it every time a node drifted two pixels would have quietly reordered
 * what agents get told.
 *
 * The row is derived data. Losing it costs a background pass, never a memory,
 * which is why it cascades away with its node and is safe to delete wholesale.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating the memory graph layout table...');

	// `placed` separates the two halves of what a pass produces, and they do NOT
	// have the same reach. Community detection runs over every live node — it is
	// linear in the edges and it is what the overview groups by, so leaving nodes
	// out of it would leave them out of the picture entirely. The force simulation
	// is superlinear and therefore capped, so the lowest-ranked nodes get their
	// community's neighbourhood as a position rather than a computed one.
	//
	// Without the flag those two are indistinguishable, and a guessed position
	// would be handed to the client as though it were a real one — every member of
	// a large lobe stacked on a single point, with nothing to say they should be
	// spread out.
	db.exec(`
		CREATE TABLE IF NOT EXISTS graph_layout (
			node_id     TEXT     PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE CASCADE,
			community   INTEGER  NOT NULL DEFAULT 0,
			x           REAL     NOT NULL DEFAULT 0,
			y           REAL     NOT NULL DEFAULT 0,
			placed      INTEGER  NOT NULL DEFAULT 1,
			updated_at  TEXT     NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_layout_community ON graph_layout (community)`);

	// Zooming into part of the map asks for the nodes inside a rectangle, which
	// without this is a scan of the whole arrangement for a handful of rows.
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_layout_position ON graph_layout (x, y)`);

	/**
	 * The graph view's own ordering, which had no index at all.
	 *
	 * `graphQueries.list` selects `ORDER BY pinned DESC, weight DESC, updated_at
	 * DESC LIMIT n`, and with nothing to read that order from SQLite had to scan
	 * every live row and sort ALL of them before taking the first few thousand.
	 * That is the one part of a fetch that grew without bound: the cap limited
	 * what was returned, never what was examined.
	 *
	 * Partial on the same predicate the view always applies, so it stays the size
	 * of the live graph however much history accumulates behind it.
	 */
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_graph_nodes_view
		ON graph_nodes (pinned DESC, weight DESC, updated_at DESC)
		WHERE archived_at IS NULL AND superseded_by IS NULL
	`);

	debug.log('migration', 'Memory graph layout table ready');
};

export const down = (db: DatabaseConnection): void => {
	db.exec(`DROP INDEX IF EXISTS idx_graph_nodes_view`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_layout_position`);
	db.exec(`DROP INDEX IF EXISTS idx_graph_layout_community`);
	db.exec(`DROP TABLE IF EXISTS graph_layout`);
};
