import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description =
	'Persist memory-graph node degree and derived edges so the view can be served as tiles';

/**
 * What a tiled Memory view needs from the arrangement and could not get.
 *
 * The view no longer asks for "the graph"; it asks for the rectangles of it that
 * are on screen, at the resolution the camera is at. Two things a tile has to
 * carry were only ever computed for a whole fetch:
 *
 *   - DEGREE sizes a node. It was counted over whatever was drawn, which for a
 *     tile is a meaningless slice — the same memory would change size as the
 *     tiles around it loaded. The layout pass already builds the full graph, so
 *     it writes each node's degree alongside its position.
 *
 *   - DERIVED EDGES (two memories naming the same subject or file) are most of
 *     the structure the episodic half has. They were derived at read time from
 *     the set being drawn, which is unbounded for the whole store and wrong for a
 *     tile: an edge whose other end sits in the next tile was never derived at
 *     all. The layout pass derives them over every live node anyway — it lays out
 *     on them — so it now keeps them. Stored edges stay in `graph_edges` and are
 *     read from there, so a connection a model records shows up without waiting
 *     for a pass.
 *
 * Both are derived and disposable like the rest of `graph_layout`: deleting them
 * costs one background pass and no memory.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding memory layout degree and derived edges...');

	const columns = db.prepare(`PRAGMA table_info(graph_layout)`).all() as { name: string }[];
	if (!columns.some(column => column.name === 'degree')) {
		db.exec(`ALTER TABLE graph_layout ADD COLUMN degree INTEGER NOT NULL DEFAULT 0`);
	}

	// Stored once per pair, smaller id first, so "edges touching this node" is the
	// union of a lookup on each column — the same shape `graph_edges` is read in.
	db.exec(`
		CREATE TABLE IF NOT EXISTS graph_layout_edges (
			src_id  TEXT  NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
			dst_id  TEXT  NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
			weight  REAL  NOT NULL DEFAULT 1,
			PRIMARY KEY (src_id, dst_id)
		) WITHOUT ROWID
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_layout_edges_dst ON graph_layout_edges (dst_id)`);

	debug.log('migration', 'Memory layout tiles ready');
};

export const down = (db: DatabaseConnection): void => {
	db.exec(`DROP INDEX IF EXISTS idx_graph_layout_edges_dst`);
	db.exec(`DROP TABLE IF EXISTS graph_layout_edges`);
	db.exec(`ALTER TABLE graph_layout DROP COLUMN degree`);
};
