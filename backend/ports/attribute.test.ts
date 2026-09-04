import { describe, expect, test } from 'bun:test';
import type { PortProcess, PortSocket } from '$shared/types/ports';
import { findClopenPids, groupListenerPids, traceAncestry } from './attribute';
import type { ProjectShell } from '../projects/shell-ownership';
import { findConnectionSshd, parseEnvironProbe, sameConnection } from './ssh-lineage';

function proc(pid: number, parentPid: number | null, command: string): PortProcess {
	return { pid, parentPid, user: 'deploy', command, startedAt: null, cwd: null };
}

function table(...processes: PortProcess[]): Map<number, PortProcess> {
	return new Map(processes.map((process) => [process.pid, process]));
}

describe('groupListenerPids', () => {
	test('collapses workers onto a master that listens alongside them', () => {
		const processes = table(
			proc(100, 1, 'node server.js'),
			proc(101, 100, 'node server.js'),
			proc(102, 100, 'node server.js')
		);

		const groups = groupListenerPids([100, 101, 102], processes);

		expect(groups).toHaveLength(1);
		expect(groups[0]).toEqual({ owner: 100, members: [100, 101, 102] });
	});

	test('collapses workers onto a shared parent that holds no socket itself', () => {
		// nginx on macOS: the master binds nothing, every worker inherits it.
		const processes = table(
			proc(500, 1, 'nginx: master process /usr/sbin/nginx'),
			proc(501, 500, 'nginx: worker process'),
			proc(502, 500, 'nginx: worker process'),
			proc(503, 500, 'nginx: worker process')
		);

		const groups = groupListenerPids([501, 502, 503], processes);

		expect(groups).toHaveLength(1);
		expect(groups[0]).toEqual({ owner: 500, members: [501, 502, 503] });
	});

	test('keeps unrelated programs apart even when they share a parent shell', () => {
		// Two different servers started from one shell, both bound to the same
		// port number on different addresses. Merging them would invent a
		// relationship that does not exist.
		const processes = table(
			proc(700, 1, '-bash'),
			proc(701, 700, 'node vite.js'),
			proc(702, 700, 'python -m http.server')
		);

		const groups = groupListenerPids([701, 702], processes);

		expect(groups).toHaveLength(2);
		expect(groups.map((group) => group.owner).sort()).toEqual([701, 702]);
	});

	test('keeps a lone listener as its own group', () => {
		const processes = table(proc(900, 1, 'redis-server'));
		expect(groupListenerPids([900], processes)).toEqual([{ owner: 900, members: [900] }]);
	});

	test('does not fold onto init when the parent chain is unknown', () => {
		// Both parents point at pid 1, which is every daemon's parent — folding
		// there would merge the whole machine into one row.
		const processes = table(proc(310, 1, 'postgres'), proc(320, 1, 'mysqld'));
		expect(groupListenerPids([310, 320], processes)).toHaveLength(2);
	});

	test('survives a parent chain that loops', () => {
		const processes = table(proc(10, 11, 'a'), proc(11, 10, 'b'));
		expect(() => groupListenerPids([10, 11], processes)).not.toThrow();
	});
});

describe('traceAncestry', () => {
	const sessions = new Map<number, ProjectShell>([
		[400, { pid: 400, sessionId: 'sess-1', projectId: 'proj-1', projectName: 'shop', cwd: '/srv/shop' }]
	]);

	test('finds the terminal session a process descends from', () => {
		const processes = table(
			proc(400, 1, '/bin/zsh'),
			proc(401, 400, 'bun run dev'),
			proc(402, 401, 'node vite.js')
		);

		const ancestry = traceAncestry(402, processes, sessions);

		expect(ancestry.session?.sessionId).toBe('sess-1');
		expect(ancestry.chain.map((process) => process.pid)).toEqual([402, 401, 400]);
	});

	test('recognises the sshd session Clopen itself is using', () => {
		// The remote counterpart of a PtyKit session pid: same tier, same
		// certainty, resolved from the host's end instead of ours.
		const processes = table(
			proc(600, 1, 'sshd: deploy@pts/0'),
			proc(601, 600, '-bash'),
			proc(602, 601, 'node vite.js')
		);

		const ancestry = traceAncestry(602, processes, new Map(), new Set([600]));

		expect(ancestry.fromClopen).toBe(true);
	});

	test('does not claim someone else’s SSH session as Clopen’s', () => {
		const processes = table(
			proc(650, 1, 'sshd: other@pts/3'),
			proc(651, 650, 'node server.js')
		);

		const ancestry = traceAncestry(651, processes, new Map(), new Set([600]));

		expect(ancestry.fromClopen).toBe(false);
		expect(ancestry.sshdUser).toBe('other');
	});

	test('reports the sshd session user when the lineage ends at sshd', () => {
		const processes = table(
			proc(600, 1, 'sshd: deploy@pts/0'),
			proc(601, 600, '-bash'),
			proc(602, 601, 'node server.js')
		);

		const ancestry = traceAncestry(602, processes, new Map());

		expect(ancestry.sshdUser).toBe('deploy');
		expect(ancestry.session).toBeNull();
	});

	test('stops cleanly when an ancestor is missing from the table', () => {
		const processes = table(proc(800, 799, 'node server.js'));
		const ancestry = traceAncestry(800, processes, new Map());
		expect(ancestry.chain.map((process) => process.pid)).toEqual([800]);
		expect(ancestry.session).toBeNull();
	});

	test('survives a parent chain that loops', () => {
		const processes = table(proc(20, 21, 'a'), proc(21, 20, 'b'));
		expect(() => traceAncestry(20, processes, new Map())).not.toThrow();
	});
});

describe('remote connection identity', () => {
	const ours = '103.0.113.7 51234 10.0.0.5 64000';

	test('matches a process started on the same SSH connection', () => {
		expect(sameConnection('103.0.113.7 51234 10.0.0.5 64000', ours)).toBe(true);
	});

	test('rejects another session from the same client machine', () => {
		// Same address, different source port — a separate connection, and the
		// port is what makes a connection unique while it is open.
		expect(sameConnection('103.0.113.7 51999 10.0.0.5 64000', ours)).toBe(false);
	});

	test('rejects a session from somewhere else entirely', () => {
		expect(sameConnection('198.51.100.4 51234 10.0.0.5 64000', ours)).toBe(false);
	});

	test('rejects an empty or unset value rather than matching loosely', () => {
		expect(sameConnection('', ours)).toBe(false);
		expect(sameConnection('$SSH_CONNECTION', ours)).toBe(false);
	});

	test('a process with our connection is claimed through the tier-2 path', () => {
		// The environment is inherited, so the listening process carries it
		// directly — no walk to a session leader is needed, which is what makes
		// this survive a disowned or reparented server.
		const processes = table(proc(42802, 42800, 'node app.js'));
		const ancestry = traceAncestry(42802, processes, new Map(), new Set([42802]));
		expect(ancestry.fromClopen).toBe(true);
	});
});

describe('parseEnvironProbe', () => {
	// One line per pid: the marker, then the matching environment entry if the
	// process had one and we were allowed to read it.
	const output = [
		'@42802 SSH_CONNECTION=103.0.113.7 51234 10.0.0.5 64000',
		'@1201 ',
		'@1310 SSH_CONNECTION=198.51.100.4 40001 10.0.0.5 64000',
		''
	].join('\n');

	const values = parseEnvironProbe(output);

	test('reads the value for each process that had one', () => {
		expect(values.get(42802)).toBe('103.0.113.7 51234 10.0.0.5 64000');
		expect(values.get(1310)).toBe('198.51.100.4 40001 10.0.0.5 64000');
	});

	test('records nothing for a process whose environment was unreadable', () => {
		// Unreadable is not the same as "not ours" — it simply has no answer.
		expect(values.has(1201)).toBe(false);
	});
});

describe('findConnectionSshd', () => {
	// The macOS path: that host reports no process environment at all, so the
	// connection has to be identified through the tree instead.
	const processes = table(
		proc(700, 1, '/usr/sbin/sshd -D'),
		proc(800, 700, 'sshd: deploy [priv]'),
		proc(815, 800, 'sshd: deploy@ttys000'),
		proc(820, 800, 'sshd: deploy@notty')
	);

	test('climbs to the sshd every channel of the connection shares', () => {
		// Resolved from the probe's own channel; the shell channel hangs off the
		// same session leader, which is what makes the whole tree ours.
		expect(findConnectionSshd(820, processes)).toBe(800);
	});

	test('stops before the listening daemon, which parents everyone’s sessions', () => {
		expect(findConnectionSshd(815, processes)).not.toBe(700);
	});

	test('returns null when the chain never looked like an SSH session', () => {
		const unlabelled = table(proc(900, 1, '/usr/sbin/sshd'), proc(910, 900, 'bash'));
		expect(findConnectionSshd(910, unlabelled)).toBeNull();
	});

	test('survives a parent chain that loops', () => {
		const looped = table(proc(30, 31, 'sshd: a@ttys000'), proc(31, 30, 'sshd: a [priv]'));
		expect(() => findConnectionSshd(30, looped)).not.toThrow();
	});
});
