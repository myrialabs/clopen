/**
 * Memory graph layout + tile tests.
 *
 * Run against a REAL in-memory SQLite database with the graph migrations
 * applied, because what is under test is the arrangement the pass leaves in the
 * table and what the tile queries read back out of it.
 *
 * The regression these exist for: warm passes used to re-settle the whole map
 * from its own previous result, which inflated it by ~1.4× per pass until the
 * coordinates overflowed to NaN and every pass failed on the NOT NULL
 * constraint. Stability across passes is therefore asserted EXACTLY, not
 * approximately.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { DatabaseConnection } from '$shared/types/database/connection';
import * as migration005 from '$backend/database/migrations/005_create_settings_table';
import * as migration066 from '$backend/database/migrations/066_create_memory_graph';
import * as migration067 from '$backend/database/migrations/067_add_memory_graph_layout';
import * as migration076 from '$backend/database/migrations/076_remove_memory_code_graph';
import * as migration089 from '$backend/database/migrations/089_add_memory_layout_tiles';

let db: Database;

// The whole module surface, not just `getDatabase` — see retrieval.test.ts.
mock.module('$backend/database', () => ({
	getDatabase: () => db,
	initializeDatabase: async () => db,
	closeDatabase: () => {},
	resetDatabase: async () => {},
	getDatabaseInfo: async () => ({}),
	vacuumDatabase: async () => {}
}));

// The pass announces its result over the WebSocket, which has no server here.
mock.module('$backend/memory/notify', () => ({
	notifyGraphChanged: () => {},
	broadcastGraphChanged: () => {},
	notifyMemoryStatus: () => {},
	notifyMemoryReadiness: () => {}
}));

const { graphQueries, graphLayoutQueries } = await import('$backend/database/queries/graph-queries');
const { runGraphLayout, resetGraphLayoutState, getLayoutState, alignTo } = await import('./layout');
const { buildGraphMeta, buildGraphTiles, locateNodes } = await import('./view');

const PROJECT = 'project-a';

function resetDatabase(): void {
	db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	const connection = db as unknown as DatabaseConnection;
	migration005.up(connection);
	migration066.up(connection);
	migration067.up(connection);
	migration076.up(connection);
	migration089.up(connection);
	resetGraphLayoutState();
}

/** A store with structure: subjects that group memories, a few stored edges, and loners. */
function seed(subjects = 6, perSubject = 12, loners = 8): string[] {
	const ids: string[] = [];
	for (let s = 0; s < subjects; s++) {
		const members: string[] = [];
		for (let m = 0; m < perSubject; m++) {
			const node = graphQueries.upsert({
				subkind: 'decision',
				projectId: PROJECT,
				label: `Subject ${s} decision ${m}`
			});
			graphQueries.setEntities(node.id, [{ key: `subject-${s}`, name: `Subject ${s}` }]);
			members.push(node.id);
		}
		// A stored edge between neighbouring subjects, so the graph is one mass
		// with lobes rather than six islands.
		if (s > 0) graphQueries.link({ srcId: ids[ids.length - 1], dstId: members[0], rel: 'relates_to' });
		ids.push(...members);
	}
	for (let l = 0; l < loners; l++) {
		ids.push(graphQueries.upsert({ subkind: 'observation', projectId: PROJECT, label: `Loner ${l}` }).id);
	}
	return ids;
}

function positions(): Map<string, { x: number; y: number; community: number }> {
	const rows = db.prepare('SELECT node_id AS id, x, y, community FROM graph_layout').all() as {
		id: string;
		x: number;
		y: number;
		community: number;
	}[];
	return new Map(rows.map(row => [row.id, { x: row.x, y: row.y, community: row.community }]));
}

/** Force the next pass to do real work rather than skip on an unchanged fingerprint. */
async function pass(): Promise<void> {
	resetGraphLayoutState();
	await runGraphLayout();
}

beforeEach(() => {
	resetDatabase();
});

describe('memory layout', () => {
	it('lays out every live memory with finite positions inside the world', async () => {
		const ids = seed();
		await pass();

		const placed = positions();
		const state = getLayoutState();
		expect(placed.size).toBe(ids.length);
		expect(state.world).not.toBeNull();
		expect(state.coldNodes).toBe(ids.length);
		// What the view sizes nodes by: the median room a memory has.
		expect(state.spacing).toBeGreaterThan(0);
		expect(Number.isFinite(state.spacing)).toBe(true);

		const world = state.world!;
		for (const point of placed.values()) {
			expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
			expect(point.x).toBeGreaterThanOrEqual(world.minX);
			expect(point.y).toBeGreaterThanOrEqual(world.minY);
			expect(point.x).toBeLessThan(world.minX + world.size);
			expect(point.y).toBeLessThan(world.minY + world.size);
		}
		// Derived edges are kept for the view to draw.
		const derived = (db.prepare('SELECT COUNT(*) AS c FROM graph_layout_edges').get() as { c: number }).c;
		expect(derived).toBeGreaterThan(0);
	});

	it('leaves the map exactly where it was across passes over unchanged data', async () => {
		seed();
		await pass();
		const first = positions();
		const epoch = getLayoutState().epoch;

		for (let i = 0; i < 4; i++) await pass();

		const later = positions();
		for (const [id, point] of first) expect(later.get(id)).toEqual(point);
		expect(getLayoutState().epoch).toBe(epoch);
	});

	it('places arrivals next to what they connect to without moving anything else', async () => {
		seed(6, 12, 8);
		await pass();
		const before = positions();
		const stamp = getLayoutState().stamp;

		// Two arrivals about an existing subject — under the re-arrangement threshold.
		const arrivals = [0, 1].map(i => {
			const node = graphQueries.upsert({ subkind: 'decision', projectId: PROJECT, label: `Arrival ${i}` });
			graphQueries.setEntities(node.id, [{ key: 'subject-0', name: 'Subject 0' }]);
			return node.id;
		});
		await pass();

		const after = positions();
		for (const [id, point] of before) expect(after.get(id)).toEqual(point);
		for (const id of arrivals) {
			const point = after.get(id);
			expect(point).toBeDefined();
			expect(Number.isFinite(point!.x) && Number.isFinite(point!.y)).toBe(true);
			// Next to what it connects to, not flung across the map: at the centre
			// of the memories its edges lead to, within a neighbour's distance or
			// two. Measured against its EDGES rather than its subject's members,
			// because Louvain is free to split one subject across several lobes.
			const partners = (
				db
					.prepare(
						`SELECT CASE WHEN src_id = ? THEN dst_id ELSE src_id END AS id FROM graph_layout_edges
						 WHERE src_id = ? OR dst_id = ?`
					)
					.all(id, id, id) as { id: string }[]
			)
				.map(row => row.id)
				.filter(partner => !arrivals.includes(partner))
				.map(partner => before.get(partner)!);
			expect(partners.length).toBeGreaterThan(0);
			const cx = partners.reduce((sum, partner) => sum + partner.x, 0) / partners.length;
			const cy = partners.reduce((sum, partner) => sum + partner.y, 0) / partners.length;
			expect(Math.hypot(point!.x - cx, point!.y - cy)).toBeLessThan(getLayoutState().spacing * 2);

			// And it takes the colour most of them carry.
			const votes = new Map<number, number>();
			for (const partner of partners) votes.set(partner.community, (votes.get(partner.community) ?? 0) + 1);
			const top = Math.max(...votes.values());
			expect(votes.get(point!.community)).toBe(top);
		}
		expect(getLayoutState().arrivals).toBe(2);
		// The stamp is what tells a client its tiles are out of date.
		expect(getLayoutState().stamp).toBeGreaterThan(stamp);
	});

	it('recovers from a diverged arrangement by laying out from scratch', async () => {
		seed();
		await pass();
		const epoch = getLayoutState().epoch;

		// What the old warm passes compounded to: coordinates near the float range.
		db.exec('UPDATE graph_layout SET x = x * 1e34, y = y * 1e34');
		await pass();

		const bounds = graphLayoutQueries.bounds();
		expect(bounds).not.toBeNull();
		expect(bounds!.magnitude).toBeLessThan(1e6);
		expect(getLayoutState().epoch).toBeGreaterThan(epoch);
	});

	it('re-arranges once the store outgrows its arrangement, keeping its colours', async () => {
		const ids = seed(6, 12, 8);
		await pass();
		const before = positions();
		const epoch = getLayoutState().epoch;

		// Well past a fifth of the store, all joining existing subjects.
		for (let i = 0; i < 24; i++) {
			const node = graphQueries.upsert({ subkind: 'pattern', projectId: PROJECT, label: `Growth ${i}` });
			graphQueries.setEntities(node.id, [{ key: `subject-${i % 6}`, name: `Subject ${i % 6}` }]);
		}
		await pass();

		const state = getLayoutState();
		expect(state.epoch).toBeGreaterThan(epoch);
		expect(state.arrivals).toBe(0);
		expect(state.coldNodes).toBe(ids.length + 24);

		// Most memories keep the community NUMBER they had, so their colour holds
		// even though Louvain numbered the new communities however it liked.
		const after = positions();
		let sameColour = 0;
		for (const [id, point] of before) if (after.get(id)?.community === point.community) sameColour++;
		expect(sameColour / before.size).toBeGreaterThan(0.6);

		const bounds = graphLayoutQueries.bounds();
		expect(bounds!.magnitude).toBeLessThan(1e6);
	});

	it('turns a fresh arrangement to face the way the previous one did, without scaling it', () => {
		const old = new Map<string, { nodeId: string; community: number; x: number; y: number; placed: number; degree: number }>();
		const fresh: { nodeId: string; community: number; x: number; y: number; placed: number; degree: number }[] = [];
		const angle = 1.27;
		for (let i = 0; i < 40; i++) {
			const x = Math.cos(i * 0.7) * (100 + i * 13);
			const y = Math.sin(i * 1.3) * (60 + i * 7);
			old.set(`n${i}`, { nodeId: `n${i}`, community: 0, x, y, placed: 1, degree: 0 });
			// The same arrangement mirrored, rotated and moved — what a fresh
			// simulation of the same graph is free to come back as.
			const mx = x;
			const my = -y;
			fresh.push({
				nodeId: `n${i}`,
				community: 0,
				x: Math.cos(angle) * mx - Math.sin(angle) * my + 5_000,
				y: Math.sin(angle) * mx + Math.cos(angle) * my - 3_000,
				placed: 1,
				degree: 0
			});
		}

		alignTo(fresh, old);

		for (const row of fresh) {
			const target = old.get(row.nodeId)!;
			expect(Math.abs(row.x - target.x)).toBeLessThan(1e-6);
			expect(Math.abs(row.y - target.y)).toBeLessThan(1e-6);
		}
	});

	it('gives archived memories a place so "show archived" can draw them', async () => {
		const ids = seed();
		graphQueries.archive(ids[3]);
		await pass();

		expect(positions().has(ids[3])).toBe(true);
		const meta = buildGraphMeta({ includeArchived: true });
		expect(meta.total).toBe(ids.length);
		expect(meta.unplaced).toBe(0);
	});
});

describe('graph tiles', () => {
	const allTiles = (z: number) => {
		const tiles: { x: number; y: number }[] = [];
		for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) tiles.push({ x, y });
		return tiles;
	};

	it('serves every memory individually when the screen can afford them', async () => {
		const ids = seed();
		await pass();
		const meta = buildGraphMeta({});

		for (const z of [0, 1, 2]) {
			const response = buildGraphTiles({ epoch: meta.epoch, z, tiles: allTiles(z), budget: 12_000 });
			expect(response.stale).toBe(false);
			const nodes = response.tiles.flatMap(tile => tile.nodes.map(node => node.id));
			expect(new Set(nodes).size).toBe(ids.length);
			expect(response.tiles.every(tile => tile.clusters.length === 0)).toBe(true);
		}
	});

	it('folds crowded tiles when the budget is small, without losing a memory', async () => {
		const ids = seed(8, 40, 10);
		await pass();
		const meta = buildGraphMeta({});

		const response = buildGraphTiles({ epoch: meta.epoch, z: 0, tiles: [{ x: 0, y: 0 }], budget: 256 });
		const [tile] = response.tiles;
		expect(tile.cells).toBeGreaterThan(0);
		expect(tile.clusters.length).toBeGreaterThan(0);
		expect(tile.nodes.length + tile.clusters.length).toBeLessThanOrEqual(256);

		const covered = tile.nodes.length + tile.clusters.reduce((sum, cluster) => sum + cluster.members, 0);
		expect(covered).toBe(ids.length);
	});

	it('answers stale instead of serving tiles from another map', async () => {
		seed();
		await pass();
		const meta = buildGraphMeta({});

		const response = buildGraphTiles({ epoch: meta.epoch + 1, z: 0, tiles: [{ x: 0, y: 0 }], budget: 12_000 });
		expect(response.stale).toBe(true);
		expect(response.tiles).toHaveLength(0);
	});

	it('sends each edge once per request, with where its far end is', async () => {
		seed();
		await pass();
		const meta = buildGraphMeta({});

		const response = buildGraphTiles({ epoch: meta.epoch, z: 2, tiles: allTiles(2), budget: 12_000 });
		const pairs = response.tiles.flatMap(tile =>
			tile.edges.map(edge => (edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`))
		);
		expect(pairs.length).toBeGreaterThan(0);
		expect(new Set(pairs).size).toBe(pairs.length);

		const placed = positions();
		for (const tile of response.tiles) {
			for (const edge of tile.edges) {
				const far = placed.get(edge.target)!;
				expect(Math.abs(edge.targetX - far.x)).toBeLessThan(0.1);
				expect(Math.abs(edge.targetY - far.y)).toBeLessThan(0.1);
			}
		}
	});

	it('narrows tiles and counts by the filter', async () => {
		seed();
		const other = graphQueries.upsert({ subkind: 'decision', projectId: 'project-b', label: 'Elsewhere' });
		await pass();

		const meta = buildGraphMeta({ projectIds: ['project-b'] });
		expect(meta.total).toBe(1);
		const response = buildGraphTiles({
			epoch: meta.epoch,
			z: 0,
			tiles: [{ x: 0, y: 0 }],
			budget: 12_000,
			projectIds: ['project-b']
		});
		expect(response.tiles[0].nodes.map(node => node.id)).toEqual([other.id]);
	});

	it('locates memories by id for going to one that is not drawn', async () => {
		const ids = seed();
		await pass();
		const located = locateNodes([ids[5], 'missing-id']);
		expect(located.map(node => node.id)).toEqual([ids[5]]);
		expect(Number.isFinite(located[0].x)).toBe(true);
	});
});
