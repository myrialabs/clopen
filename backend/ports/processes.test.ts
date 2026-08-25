import { describe, expect, test } from 'bun:test';
import { parseLsofCwd, parseProcCwd, parsePsOutput, parseWindowsProcesses } from './processes';

describe('parsePsOutput', () => {
	// `ps -o pid=,ppid=,user=,lstart=,args=` — lstart is always five tokens, so
	// the row is read positionally and the argv keeps its own spaces.
	const output = [
		'    1     0 root             Tue Aug 25 08:24:48 2026     /sbin/launchd',
		' 1310  1200 deploy           Tue Aug 25 09:02:11 2026     node /srv/app/node_modules/.bin/vite --port 5173',
		'  640     1 root             Tue Aug 25 08:24:52 2026     nginx: master process /usr/sbin/nginx -g daemon off;',
		''
	].join('\n');

	const processes = parsePsOutput(output);

	test('reads every row', () => {
		expect(processes).toHaveLength(3);
	});

	test('keeps the full command line including its arguments', () => {
		expect(processes[1].command).toBe('node /srv/app/node_modules/.bin/vite --port 5173');
		expect(processes[2].command).toBe('nginx: master process /usr/sbin/nginx -g daemon off;');
	});

	test('reads pid, parent and user', () => {
		expect(processes[1]).toMatchObject({ pid: 1310, parentPid: 1200, user: 'deploy' });
	});

	test('turns the five lstart tokens into a timestamp', () => {
		expect(processes[0].startedAt).toBe(new Date('Tue Aug 25 08:24:48 2026').toISOString());
	});

	test('reports no start time rather than a wrong one when the date is unreadable', () => {
		// A non-English locale prints month names `Date` cannot parse.
		const localised = '  900     1 root             mar. ao\u00fbt 25 08:24:48 2026     /usr/sbin/cron';
		expect(parsePsOutput(localised)[0]).toMatchObject({ pid: 900, startedAt: null });
	});

	test('skips rows too short to be a process', () => {
		expect(parsePsOutput('garbage\n\n  1 0 root\n')).toHaveLength(0);
	});
});

describe('parseWindowsProcesses', () => {
	const output = [
		'ProcessId        : 1044',
		'ParentProcessId  : 640',
		'Name             : node.exe',
		'CommandLine      : "C:\\Program Files\\nodejs\\node.exe" server.js',
		'CreationDate     : 2026-08-25T09:02:11',
		'',
		'ProcessId        : 4',
		'ParentProcessId  : 0',
		'Name             : System',
		'CommandLine      :',
		'CreationDate     :',
		''
	].join('\n');

	const processes = parseWindowsProcesses(output);

	test('reads one process per blank-line-separated block', () => {
		expect(processes).toHaveLength(2);
	});

	test('prefers the command line over the bare name', () => {
		expect(processes[0].command).toBe('"C:\\Program Files\\nodejs\\node.exe" server.js');
	});

	test('falls back to the name when there is no command line', () => {
		expect(processes[1].command).toBe('System');
		expect(processes[1].startedAt).toBeNull();
	});
});

describe('cwd probes', () => {
	test('parses lsof cwd blocks', () => {
		const output = ['p1310', 'fcwd', 'n/srv/app', 'p1400', 'fcwd', 'n/srv/api', ''].join('\n');
		expect([...parseLsofCwd(output).entries()]).toEqual([
			[1310, '/srv/app'],
			[1400, '/srv/api']
		]);
	});

	test('parses /proc symlink listings and ignores rows it could not read', () => {
		const output = [
			'lrwxrwxrwx 1 deploy deploy 0 Aug 25 09:02 /proc/1310/cwd -> /srv/app',
			"ls: cannot read symbolic link '/proc/800/cwd': Permission denied",
			'lrwxrwxrwx 1 deploy deploy 0 Aug 25 09:02 /proc/1400/cwd -> /srv/api',
			''
		].join('\n');

		const cwds = parseProcCwd(output);
		expect(cwds.get(1310)).toBe('/srv/app');
		expect(cwds.get(1400)).toBe('/srv/api');
		expect(cwds.has(800)).toBe(false);
	});
});
