/**
 * Belief revision, structural invalidation and retention.
 *
 * Against a real in-memory SQLite database with both migrations applied, for the
 * same reason `retrieval.test.ts` does it: the behaviour under test is mostly SQL
 * — which rows a superseded node disappears from, which subkinds decay, which
 * nodes retention is allowed to touch — and a mocked query layer would assert the
 * test's idea of that SQL rather than the database's.
 *
 * The vector-dependent half (near-duplicate detection) needs the on-demand
 * embedding artifact and is skipped without it.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { DatabaseConnection } from '$shared/types/database/connection';
import * as migration066 from '$backend/database/migrations/066_create_memory_graph';

let db: Database;

// The whole module surface, not just `getDatabase`. `mock.module` replaces the
// module for the entire test PROCESS, so a partial stub leaves any file that runs
// afterwards unable to import the missing names — surfacing as
// "Export named 'closeDatabase' not found" in a test that never touched memory.
mock.module('$backend/database', () => ({
	getDatabase: () => db,
	initializeDatabase: async () => db,
	closeDatabase: () => {},
	resetDatabase: async () => {},
	getDatabaseInfo: async () => ({}),
	vacuumDatabase: async () => {}
}));

const { graphQueries, entityKeyFor } = await import('$backend/database/queries/graph-queries');
const { retrieve } = await import('./retrieval');
const { applyFeedback, recordContradictions, linkEntities } = await import('./revise');
const { invalidateForChanges } = await import('./invalidate');
const { applyRetention } = await import('./retention');

const PROJECT = 'project-a';

function memory(label: string, overrides: Record<string, unknown> = {}) {
	return graphQueries.upsert({
		kind: 'episodic',
		subkind: 'decision',
		projectId: PROJECT,
		label,
		...overrides
	} as Parameters<typeof graphQueries.upsert>[0]);
}

function file(path: string) {
	return graphQueries.upsert({
		kind: 'structural',
		subkind: 'file',
		projectId: PROJECT,
		label: path,
		path
	});
}

/** Backdate a node so age-gated behaviour can be exercised without waiting. */
function backdate(id: string, days: number): void {
	db.prepare(
		`UPDATE graph_nodes SET updated_at = datetime('now', ?), archived_at =
		   CASE WHEN archived_at IS NULL THEN NULL ELSE datetime('now', ?) END
		 WHERE id = ?`
	).run(`-${days} days`, `-${days} days`, id);
}

beforeEach(() => {
	db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	migration066.up(db as unknown as DatabaseConnection);
	// The queue's orphan sweep joins against sessions; a stub is enough here.
	db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY)`);
});

describe('supersession', () => {
	it('removes the old belief from retrieval but keeps it readable', () => {
		const old = memory('The project uses Postgres for storage');
		const current = memory('The project uses SQLite for storage');

		expect(graphQueries.supersede(old.id, current.id)).toBe(true);

		const hits = retrieve({ query: 'storage project uses', projectId: PROJECT, expandHops: 0 }).hits;
		expect(hits.map(h => h.node.id)).not.toContain(old.id);

		// Not archived: it was true once, and the distinction is the point.
		const stored = graphQueries.getById(old.id)!;
		expect(stored.archivedAt).toBeNull();
		expect(stored.supersededBy).toBe(current.id);
	});

	it('records an edge so the history of a decision stays answerable', () => {
		const old = memory('Sessions are keyed by user id');
		const current = memory('Sessions are keyed by device id');
		graphQueries.supersede(old.id, current.id);

		const edges = graphQueries.edgesOf(current.id);
		expect(edges.some(e => e.rel === 'supersedes' && e.dstId === old.id)).toBe(true);
	});

	it('collapses a chain rather than leaving it to be walked at read time', () => {
		// A → B → C must leave A pointing at C. Otherwise "is this current?" needs a
		// recursive walk on a path that runs on every turn.
		const a = memory('v1');
		const b = memory('v2');
		const c = memory('v3');

		graphQueries.supersede(a.id, b.id);
		graphQueries.supersede(b.id, c.id);

		expect(graphQueries.getById(a.id)!.supersededBy).toBe(c.id);
	});

	it('refuses to create a cycle', () => {
		const a = memory('A');
		const b = memory('B');
		graphQueries.supersede(a.id, b.id);
		expect(graphQueries.supersede(b.id, a.id)).toBe(false);
	});

	it('ignores an id the model was never shown', () => {
		// The model can only relate to memories it actually read. Anything else was
		// hallucinated, and drawing an edge to it would assert a disagreement
		// nothing observed.
		const shown = memory('Shown to the model');
		const unshown = memory('Never shown to the model');
		const fresh = memory('The new belief');

		recordContradictions(fresh.id, [shown.id, unshown.id], new Set([shown.id]));

		const edges = graphQueries.edgesOf(fresh.id).filter(e => e.rel === 'contradicts');
		expect(edges.map(e => e.dstId)).toEqual([shown.id]);
	});

	it('records a contradiction instead of retiring anything', () => {
		// The whole correction: automatic revision NOTICES, the read path CHOOSES.
		// A model reading one turn cannot tell a repealed rule from an exception
		// being taken, and freezing that guess into a destructive write is what let
		// a task-local exception retire a standing prohibition.
		const standing = memory('Never use the agent tool', { subkind: 'preference', scope: 'global', projectId: null });
		const exception = memory('Use the agent tool for this analysis', {
			subkind: 'preference',
			scope: 'session',
			projectId: null
		});

		recordContradictions(exception.id, [standing.id], new Set([standing.id]));

		expect(graphQueries.getById(standing.id)!.supersededBy).toBeNull();
		expect(graphQueries.getById(exception.id)!.supersededBy).toBeNull();
		expect(graphQueries.edgesOf(exception.id).some(e => e.rel === 'contradicts' && e.dstId === standing.id)).toBe(
			true
		);
	});

	it('refuses to let an inference retire something the user stated', () => {
		// The measured production failure, pinned. `source` said "a model wrote
		// both"; the question every consumer was actually asking is "who said it",
		// and nothing could answer it until `asserted_by` existed.
		const stated = memory('Never use the agent tool', { assertedBy: 'user', subkind: 'preference' });
		const inferred = memory('The agent tool is appropriate for deep analysis', {
			assertedBy: 'inferred',
			subkind: 'preference'
		});

		expect(graphQueries.supersede(stated.id, inferred.id)).toBe(false);
		expect(graphQueries.getById(stated.id)!.supersededBy).toBeNull();
	});

	it('refuses to let a one-off instruction repeal a standing rule', () => {
		// Independent of authority: an exception taken for one task is not a policy,
		// however recently or confidently it was taken.
		const standing = memory('Always run the checks before committing', { scope: 'global', projectId: null });
		const oneOff = memory('Skip the checks for this commit', { scope: 'session', projectId: null });

		expect(graphQueries.supersede(standing.id, oneOff.id)).toBe(false);
		expect(graphQueries.getById(standing.id)!.supersededBy).toBeNull();
	});

	it('leaves superseded memories out of stats and the graph view', () => {
		const old = memory('Old');
		const current = memory('New');
		graphQueries.supersede(old.id, current.id);

		const stats = graphQueries.stats();
		expect(stats.episodic).toBe(1);
		expect(stats.superseded).toBe(1);
		expect(graphQueries.list({ projectId: PROJECT }).map(n => n.id)).not.toContain(old.id);
	});
});

describe('usefulness feedback', () => {
	it('rewards a memory the next turn actually used', () => {
		const node = memory('Bun is the only supported runtime');
		applyFeedback([{ id: node.id, verdict: 'used' }], new Set([node.id]));

		const after = graphQueries.getById(node.id)!;
		expect(after.usefulCount).toBe(1);
		expect(after.weight).toBeGreaterThan(node.weight);
		expect(after.confidence).toBeGreaterThan(node.confidence);
	});

	it('costs confidence when a turn shows a memory to be wrong', () => {
		const node = memory('The default port is 3000', { confidence: 0.8 });
		applyFeedback([{ id: node.id, verdict: 'wrong' }], new Set([node.id]));
		expect(graphQueries.getById(node.id)!.confidence).toBeLessThan(0.8);
	});

	it('treats "ignored" as weak evidence and does not punish confidence', () => {
		// Most memories offered to a turn have no bearing on it through no fault of
		// their own. Decaying them for that would empty the graph of anything niche.
		const node = memory('Snapshots are gitignore-aware', { confidence: 0.7 });
		applyFeedback([{ id: node.id, verdict: 'ignored' }], new Set([node.id]));

		const after = graphQueries.getById(node.id)!;
		expect(after.confidence).toBe(0.7);
		expect(after.unhelpfulCount).toBe(1);
	});

	it('ignores a verdict for a memory that was never injected', () => {
		const node = memory('Never handed to the turn', { confidence: 0.8 });
		applyFeedback([{ id: node.id, verdict: 'wrong' }], new Set(['some-other-id']));
		expect(graphQueries.getById(node.id)!.confidence).toBe(0.8);
	});
});

describe('canonical entities', () => {
	it('collapses differently-worded names onto one key', () => {
		expect(entityKeyFor('Arga Fairuz')).toBe(entityKeyFor('arga  fairuz.'));
		expect(entityKeyFor('!')).toBeNull();
	});

	it('gathers several statements about one person without creating a node', () => {
		// The failure this replaces: five memories about one person sitting as five
		// islands. The fix used to be a stub NODE per subject, which on a real graph
		// made 115 of 208 nodes empty-bodied names. An index answers the same
		// question and adds nothing to the graph.
		const a = memory('Arga prefers Svelte 5 runes', { subkind: 'preference' });
		const b = memory('Arga works full-stack in TypeScript', { subkind: 'entity' });
		const c = memory('Arga is based in Indonesia', { subkind: 'observation' });

		for (const node of [a, b, c]) linkEntities(node.id, ['Arga']);

		const about = graphQueries.memoriesAboutEntity('arga').map(n => n.id);
		expect(about).toEqual(expect.arrayContaining([a.id, b.id, c.id]));

		// And no stub was created for it.
		expect(graphQueries.list({ projectId: null }).filter(n => n.entityKey !== null)).toHaveLength(0);
	});

	it('keeps spelling variants of one subject on the same key', () => {
		// The old normaliser kept punctuation as a separator, so "Myria Labs" and
		// "MyriaLabs" keyed differently — a dozen of 115 entities on the real graph
		// were pure spelling forks.
		expect(entityKeyFor('Myria Labs')).toBe(entityKeyFor('MyriaLabs'));
		expect(entityKeyFor('Express')).toBe(entityKeyFor('Express.js'));
		expect(entityKeyFor('Vue')).toBe(entityKeyFor('Vue 3'));
		expect(entityKeyFor('Tailwind CSS')).toBe(entityKeyFor('Tailwind CSS v4'));
		// But two different things stay apart: the second is not a version of the first.
		expect(entityKeyFor('Docker')).not.toBe(entityKeyFor('Docker Compose'));
	});

	it('replaces a memory\'s entities rather than accumulating every phrasing', () => {
		const node = memory('The billing cutover is in March');
		linkEntities(node.id, ['Phoenix', 'Stripe']);
		linkEntities(node.id, ['Phoenix']);

		expect(graphQueries.entityNamesOf(node.id)).toEqual(['Phoenix']);
	});
});

describe('structural invalidation', () => {
	it('ages an observation about changed code but not the decision behind it', () => {
		const target = file('backend/chat/stream-manager.ts');
		const observation = memory('Stream manager captures the snapshot in its finally block', {
			subkind: 'observation',
			confidence: 0.9
		});
		const decision = memory('Snapshots are captured at stream end so Bash edits are seen', {
			subkind: 'decision',
			confidence: 0.9
		});
		const preference = memory('Arga wants English in all durable text', {
			subkind: 'preference',
			confidence: 0.9
		});

		for (const node of [observation, decision, preference]) {
			graphQueries.link({ srcId: node.id, dstId: target.id, rel: 'about' });
		}

		invalidateForChanges({ projectId: PROJECT, changedPaths: ['backend/chat/stream-manager.ts'] });

		expect(graphQueries.getById(observation.id)!.confidence).toBeLessThan(0.9);
		expect(graphQueries.getById(observation.id)!.staleAt).not.toBeNull();
		// The reason a file changed is not invalidated by the file changing — very
		// often it IS the change.
		expect(graphQueries.getById(decision.id)!.confidence).toBe(0.9);
		expect(graphQueries.getById(preference.id)!.confidence).toBe(0.9);
	});

	it('never ages a memory a person wrote or pinned', () => {
		const target = file('backend/a.ts');
		const authored = memory('Hand-written note about a.ts', {
			subkind: 'observation',
			confidence: 0.9,
			source: 'user'
		});
		const pinned = memory('Pinned note about a.ts', {
			subkind: 'observation',
			confidence: 0.9,
			pinned: true
		});
		for (const node of [authored, pinned]) {
			graphQueries.link({ srcId: node.id, dstId: target.id, rel: 'about' });
		}

		invalidateForChanges({ projectId: PROJECT, changedPaths: ['backend/a.ts'] });

		expect(graphQueries.getById(authored.id)!.confidence).toBe(0.9);
		expect(graphQueries.getById(pinned.id)!.confidence).toBe(0.9);
	});

	it('retires the nodes of a file that no longer exists', () => {
		// Otherwise BM25 keeps offering a path that is gone, which sends an agent to
		// read a file that was deleted — a specific, repeatable waste of a turn.
		file('backend/gone.ts');
		graphQueries.upsert({
			kind: 'structural',
			subkind: 'symbol',
			projectId: PROJECT,
			label: 'goneHelper',
			path: 'backend/gone.ts',
			symbol: 'goneHelper'
		});

		const result = invalidateForChanges({
			projectId: PROJECT,
			changedPaths: [],
			deletedPaths: ['backend/gone.ts']
		});

		expect(result.archived).toBe(2);
		const hits = retrieve({ query: 'goneHelper', projectId: PROJECT, expandHops: 0 }).hits;
		expect(hits).toHaveLength(0);
	});

	it('clears staleness when the memory is re-observed', () => {
		const target = file('backend/b.ts');
		const node = memory('b.ts exports a queue', { subkind: 'observation', confidence: 0.9 });
		graphQueries.link({ srcId: node.id, dstId: target.id, rel: 'about' });
		invalidateForChanges({ projectId: PROJECT, changedPaths: ['backend/b.ts'] });
		expect(graphQueries.getById(node.id)!.staleAt).not.toBeNull();

		// Re-extracting the same claim is the evidence that it survived the change.
		memory('b.ts exports a queue', { subkind: 'observation' });
		expect(graphQueries.getById(node.id)!.staleAt).toBeNull();
	});
});

describe('retention', () => {
	it('archives an old auto memory that has never proved anything', () => {
		const node = memory('An inference nobody ever used', { confidence: 0.3 });
		backdate(node.id, 200);

		applyRetention();
		expect(graphQueries.getById(node.id)!.archivedAt).not.toBeNull();
	});

	it.each([
		['user-authored', { source: 'user' as const, confidence: 0.3 }],
		['pinned', { pinned: true, confidence: 0.3 }],
		['confident', { confidence: 0.9 }]
	])('never evicts a %s memory', (_label, overrides) => {
		const node = memory(`Protected: ${_label}`, overrides);
		backdate(node.id, 400);

		applyRetention();
		expect(graphQueries.getById(node.id)!.archivedAt).toBeNull();
	});

	it('never evicts a memory that was confirmed useful', () => {
		const node = memory('Low confidence but it worked', { confidence: 0.2 });
		applyFeedback([{ id: node.id, verdict: 'used' }], new Set([node.id]));
		backdate(node.id, 400);

		applyRetention();
		expect(graphQueries.getById(node.id)!.archivedAt).toBeNull();
	});

	it('permanently removes an auto node archived long ago', () => {
		const node = memory('Archived and forgotten');
		graphQueries.archive(node.id);
		backdate(node.id, 200);

		applyRetention();
		expect(graphQueries.getById(node.id)).toBeNull();
	});

	it('keeps a recently archived node so it can still be restored', () => {
		const node = memory('Archived yesterday');
		graphQueries.archive(node.id);
		backdate(node.id, 1);

		applyRetention();
		expect(graphQueries.getById(node.id)).not.toBeNull();
	});
});

describe('forgetting and deleting', () => {
	/**
	 * Edges deliberately survive archiving — that is what keeps the reasoning trail
	 * intact — so a traversal that does not filter walks straight into a memory the
	 * user has already forgotten and presents it as a live connection. Retrieval
	 * filtered correctly while the inspector and the MCP `neighbours` action did
	 * not, which is why forgotten memories kept reappearing.
	 */
	it('keeps a forgotten memory out of a neighbour walk', () => {
		const target = file('backend/auth.ts');
		const live = memory('Auth uses short-lived tokens');
		const forgotten = memory('Auth used to use cookies');
		for (const node of [live, forgotten]) {
			graphQueries.link({ srcId: node.id, dstId: target.id, rel: 'about' });
		}

		graphQueries.archive(forgotten.id);

		const ids = graphQueries.neighbours(target.id, 1).map(n => n.node.id);
		expect(ids).toContain(live.id);
		expect(ids).not.toContain(forgotten.id);
		// The edge itself is untouched: this is a display rule, not a deletion.
		expect(graphQueries.edgesOf(forgotten.id)).toHaveLength(1);
	});

	it('keeps a superseded memory out of a neighbour walk', () => {
		const target = file('backend/db.ts');
		const current = memory('Storage is SQLite');
		const old = memory('Storage is Postgres');
		for (const node of [current, old]) {
			graphQueries.link({ srcId: node.id, dstId: target.id, rel: 'about' });
		}
		graphQueries.supersede(old.id, current.id);

		const ids = graphQueries.neighbours(target.id, 1).map(n => n.node.id);
		expect(ids).not.toContain(old.id);
	});

	it('lists both the archived and the superseded as forgotten', () => {
		const archived = memory('Wrong from the start');
		const old = memory('True once');
		const current = memory('True now');
		graphQueries.archive(archived.id);
		graphQueries.supersede(old.id, current.id);

		const ids = graphQueries.listArchived({ projectId: PROJECT }).map(n => n.id);
		expect(ids).toEqual(expect.arrayContaining([archived.id, old.id]));
		expect(ids).not.toContain(current.id);
		expect(graphQueries.countArchived({ projectId: PROJECT })).toBe(2);
	});

	it('hard-deletes selected nodes and their edges', () => {
		const node = memory('To be deleted');
		const target = file('backend/x.ts');
		graphQueries.link({ srcId: node.id, dstId: target.id, rel: 'about' });
		graphQueries.archive(node.id);

		expect(graphQueries.deleteNodes([node.id])).toBe(1);
		expect(graphQueries.getById(node.id)).toBeNull();
		expect(graphQueries.edgesOf(target.id)).toHaveLength(0);
	});

	it('does not orphan a node whose replacement was deleted', () => {
		// Otherwise the older memory keeps a `superseded_by` pointing at nothing,
		// which hides it from every read forever with no way to find out why.
		const old = memory('Older belief');
		const current = memory('Newer belief');
		graphQueries.supersede(old.id, current.id);

		graphQueries.deleteNodes([current.id]);
		expect(graphQueries.getById(old.id)!.supersededBy).toBeNull();
	});
});

describe('purge', () => {
	it('empties one project and leaves the others alone', () => {
		const mine = memory('Belongs to project A');
		const theirs = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'decision',
			projectId: 'project-b',
			label: 'Belongs to project B'
		});

		const result = graphQueries.purge([PROJECT]);
		expect(result.nodes).toBeGreaterThan(0);
		expect(graphQueries.getById(mine.id)).toBeNull();
		expect(graphQueries.getById(theirs.id)).not.toBeNull();
	});

	it('leaves global memories alone when one project is purged', () => {
		// Preferences and conventions were never that repository's to hold, so losing
		// them because one project was cleaned would be a surprise.
		const global = graphQueries.upsert({
			kind: 'episodic',
			subkind: 'preference',
			scope: 'global',
			projectId: null,
			label: 'Writes everything in English'
		});
		memory('Belongs to the project');

		graphQueries.purge([PROJECT]);
		expect(graphQueries.getById(global.id)).not.toBeNull();
	});

	it('empties everything when no project is named', () => {
		memory('Project memory');
		graphQueries.upsert({
			kind: 'episodic',
			subkind: 'preference',
			scope: 'global',
			projectId: null,
			label: 'Global memory'
		});

		graphQueries.purge();
		expect(graphQueries.stats().nodes).toBe(0);
		expect(graphQueries.stats().edges).toBe(0);
	});

	it('leaves nothing in the lexical index behind', () => {
		// The FTS mirror is not a foreign key, so a purge that forgets it leaves
		// search returning rows whose nodes no longer exist.
		memory('Findable by search', { body: 'something distinctive to match on' });
		graphQueries.purge();

		expect(retrieve({ query: 'distinctive', projectId: PROJECT }).hits).toHaveLength(0);
	});
});

describe('who wrote it', () => {
	it('records an agent edit as an agent edit', () => {
		// This hard-coded `'user'`, and the MCP `update` action goes through it — so
		// one correction by a model made the node permanently exempt from structural
		// decay, from eviction and from consolidation, while the injected block told
		// every future turn a person had said it.
		const node = memory('The cache is invalidated on write');
		const edited = graphQueries.update(node.id, { label: 'The cache is invalidated on read' }, 'agent');

		expect(edited!.source).toBe('agent');
		expect(edited!.label).toBe('The cache is invalidated on read');
	});

	it('leaves a hand-written memory untouched by structural decay', () => {
		const target = file('src/cache.ts');
		const mine = memory('The cache is invalidated on write', { subkind: 'observation', source: 'user' });
		graphQueries.link({ srcId: mine.id, dstId: target.id, rel: 'about' });

		invalidateForChanges({ projectId: PROJECT, changedPaths: ['src/cache.ts'] });

		const after = graphQueries.getById(mine.id)!;
		expect(after.staleAt).toBeNull();
		expect(after.confidence).toBe(mine.confidence);
	});
});

describe('structural decay', () => {
	it('does not compound when the same file changes repeatedly', () => {
		// Ten turns of iterating on one file used to multiply an observation's
		// confidence by 0.82 ten times over — 0.14, below the injection floor — so an
		// ordinary afternoon silently destroyed everything known about whatever was
		// being worked on.
		const target = file('src/stream.ts');
		const note = memory('The stream captures its snapshot in a finally block', {
			subkind: 'observation',
			confidence: 0.9
		});
		graphQueries.link({ srcId: note.id, dstId: target.id, rel: 'about' });

		for (let turn = 0; turn < 10; turn++) {
			invalidateForChanges({ projectId: PROJECT, changedPaths: ['src/stream.ts'] });
		}

		const after = graphQueries.getById(note.id)!;
		// Exactly one application of the observation rate, not ten.
		expect(after.confidence).toBeCloseTo(0.9 * 0.82, 5);
		expect(after.staleAt).not.toBeNull();
	});

	it('ages it again once the cool-off has passed', () => {
		const target = file('src/stream.ts');
		const note = memory('An observation about the stream', { subkind: 'observation', confidence: 0.9 });
		graphQueries.link({ srcId: note.id, dstId: target.id, rel: 'about' });

		invalidateForChanges({ projectId: PROJECT, changedPaths: ['src/stream.ts'] });
		db.prepare(`UPDATE graph_nodes SET stale_at = datetime('now', '-2 days') WHERE id = ?`).run(note.id);
		invalidateForChanges({ projectId: PROJECT, changedPaths: ['src/stream.ts'] });

		expect(graphQueries.getById(note.id)!.confidence).toBeCloseTo(0.9 * 0.82 * 0.82, 5);
	});
});

describe('restoring', () => {
	it('undoes a supersession, not only an archive', () => {
		// Supersession is a judgement a model made while reading a transcript.
		// Leaving it as the one thing a user could not undo meant their only recourse
		// against a wrong revision was permanent deletion.
		const old = memory('Deploys go out on Fridays');
		const current = memory('Deploys go out on Tuesdays');
		graphQueries.supersede(old.id, current.id);

		expect(graphQueries.restoreNodes([old.id])).toBe(1);

		const after = graphQueries.getById(old.id)!;
		expect(after.supersededBy).toBeNull();
		expect(after.archivedAt).toBeNull();
		// The edge goes with it: leaving it would draw a claim nothing is making.
		expect(graphQueries.edgesOf(current.id).some(e => e.rel === 'supersedes')).toBe(false);
	});

	it('puts a restored memory back into search', () => {
		const node = memory('Findable again', { body: 'a distinctive phrase to match on' });
		graphQueries.archive(node.id);
		expect(retrieve({ query: 'distinctive', projectId: PROJECT }).hits).toHaveLength(0);

		graphQueries.restoreNodes([node.id]);
		expect(retrieve({ query: 'distinctive', projectId: PROJECT }).hits.map(h => h.node.id)).toContain(node.id);
	});

	it('restores a whole selection in one call', () => {
		const a = memory('First');
		const b = memory('Second');
		graphQueries.archive(a.id);
		graphQueries.archive(b.id);

		expect(graphQueries.restoreNodes([a.id, b.id])).toBe(2);
		expect(graphQueries.getById(a.id)!.archivedAt).toBeNull();
		expect(graphQueries.getById(b.id)!.archivedAt).toBeNull();
	});
});

describe('bounding the structural half', () => {
	it('removes symbols nothing refers to and nothing has touched', () => {
		// The structural half is what actually grows without bound — a node per
		// changed file, per directory and up to twenty-five per file's symbols, every
		// turn — and none of the episodic retention queries look at it at all.
		const symbol = graphQueries.upsert({
			kind: 'structural',
			subkind: 'symbol',
			projectId: PROJECT,
			label: 'forgottenHelper',
			path: 'src/old.ts',
			symbol: 'forgottenHelper'
		});
		backdate(symbol.id, 200);

		expect(graphQueries.pruneStructural({ maxAgeDays: 120, limit: 100 })).toBe(1);
		expect(graphQueries.getById(symbol.id)).toBeNull();
	});

	it('spares a symbol a memory is about', () => {
		// Deleting it would sever the `about` edge, which is the join both halves of
		// the graph exist for.
		const symbol = graphQueries.upsert({
			kind: 'structural',
			subkind: 'symbol',
			projectId: PROJECT,
			label: 'loadBearing',
			path: 'src/core.ts',
			symbol: 'loadBearing'
		});
		const note = memory('loadBearing must stay synchronous');
		graphQueries.link({ srcId: note.id, dstId: symbol.id, rel: 'about' });
		backdate(symbol.id, 200);

		expect(graphQueries.pruneStructural({ maxAgeDays: 120, limit: 100 })).toBe(0);
		expect(graphQueries.getById(symbol.id)).not.toBeNull();
	});

	it('spares file nodes, however old', () => {
		// A file node is what a path lookup resolves to, and `invalidate.ts` already
		// retires files the moment the disk says they are gone — better evidence
		// than age.
		const node = file('src/rarely-touched.ts');
		backdate(node.id, 400);

		expect(graphQueries.pruneStructural({ maxAgeDays: 120, limit: 100 })).toBe(0);
		expect(graphQueries.getById(node.id)).not.toBeNull();
	});
});
