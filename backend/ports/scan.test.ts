import { describe, expect, test } from 'bun:test';
import type { CommandRunner } from '../host/runner';
import {
	parseLsof,
	parseNetstatUnix,
	parseNetstatWindows,
	parseProcFdInodes,
	parseProcNet,
	parseSs,
	scanSockets
} from './scan';

/**
 * Fixtures are shaped like real probe output but describe an invented machine,
 * so nothing about a contributor's own box ends up in the repository.
 */

describe('parseLsof', () => {
	// Field blocks as `lsof -FpcLfPntT` emits them: a process block, then one
	// block per socket, with process fields carrying forward.
	const output = [
		'p1200',
		'cnginx',
		'Lwww',
		'f6',
		'tIPv4',
		'PTCP',
		'n*:8080',
		'TST=LISTEN',
		'TQR=0',
		'f7',
		'tIPv6',
		'PTCP',
		'n[::1]:8080',
		'TST=LISTEN',
		'p1310',
		'cnode',
		'Ldeploy',
		'f22',
		'tIPv4',
		'PTCP',
		'n127.0.0.1:5173',
		'TST=LISTEN',
		'f23',
		'tIPv4',
		'PTCP',
		'n127.0.0.1:5173->127.0.0.1:54120',
		'TST=ESTABLISHED',
		'f24',
		'tIPv4',
		'PUDP',
		'n*:5353',
		''
	].join('\n');

	const sockets = parseLsof(output);

	test('reads every socket across process blocks', () => {
		expect(sockets).toHaveLength(5);
	});

	test('carries process identity forward across a process’s sockets', () => {
		expect(sockets[0]).toMatchObject({ pid: 1200, processName: 'nginx', user: 'www' });
		expect(sockets[1]).toMatchObject({ pid: 1200, port: 8080, ipVersion: 'v6', address: '::1' });
		expect(sockets[2]).toMatchObject({ pid: 1310, processName: 'node', user: 'deploy' });
	});

	test('splits an established socket into local and peer', () => {
		expect(sockets[3]).toMatchObject({
			state: 'established',
			port: 5173,
			peerAddress: '127.0.0.1',
			peerPort: 54120
		});
	});

	test('treats a bound UDP socket with no peer as listening', () => {
		expect(sockets[4]).toMatchObject({ protocol: 'udp', port: 5353, state: 'listen', address: '*' });
	});
});

describe('parseSs', () => {
	const output = [
		'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
		'tcp   LISTEN 0      128    0.0.0.0:22         0.0.0.0:*         users:(("sshd",pid=800,fd=3))',
		'tcp   LISTEN 0      511    [::]:443           [::]:*            users:(("caddy",pid=910,fd=8),("caddy",pid=911,fd=8))',
		'tcp   ESTAB  0      0      10.0.0.5:22        10.0.0.9:51234    users:(("sshd",pid=1422,fd=4))',
		'udp   UNCONN 0      0      0.0.0.0:68         0.0.0.0:*',
		''
	].join('\n');

	const sockets = parseSs(output);

	test('skips the header and keeps every socket row', () => {
		expect(sockets).toHaveLength(4);
	});

	test('pulls the owning pid out of the users:(…) field', () => {
		expect(sockets[0]).toMatchObject({ port: 22, state: 'listen', pid: 800, processName: 'sshd' });
		expect(sockets[1]).toMatchObject({ port: 443, pid: 910, processName: 'caddy' });
	});

	test('normalises a wildcard bind and reads the IP family from the address', () => {
		expect(sockets[0].address).toBe('*');
		expect(sockets[1]).toMatchObject({ address: '*', ipVersion: 'v4' });
	});

	test('records the peer of an established socket', () => {
		expect(sockets[2]).toMatchObject({ state: 'established', peerAddress: '10.0.0.9', peerPort: 51234 });
	});

	test('leaves the owner null when the kernel withheld it', () => {
		expect(sockets[3]).toMatchObject({ protocol: 'udp', port: 68, pid: null, state: 'listen' });
	});
});

describe('parseNetstatUnix', () => {
	const output = [
		'Active Internet connections (servers and established)',
		'Proto Recv-Q Send-Q Local Address Foreign Address State PID/Program name',
		'tcp        0      0 0.0.0.0:22      0.0.0.0:*     LISTEN      800/sshd',
		'tcp6       0      0 :::443          :::*          LISTEN      -',
		'tcp        0      0 10.0.0.5:22     10.0.0.9:5123 ESTABLISHED 1422/sshd: deploy',
		'udp        0      0 0.0.0.0:68      0.0.0.0:*                 640/dhclient',
		''
	].join('\n');

	const sockets = parseNetstatUnix(output);

	test('keeps only socket rows', () => {
		expect(sockets).toHaveLength(4);
	});

	test('reads the family from the proto column rather than guessing', () => {
		// A wildcard IPv6 bind prints as `:::443`, which looks like no address at
		// all once normalised — only `tcp6` says which family it is.
		expect(sockets[1]).toMatchObject({ port: 443, ipVersion: 'v6', address: '*' });
	});

	test('treats a withheld owner as unknown rather than pid 0', () => {
		expect(sockets[1].pid).toBeNull();
	});

	test('takes the owner from the right column for UDP, which has no state', () => {
		expect(sockets[3]).toMatchObject({ protocol: 'udp', port: 68, pid: 640, processName: 'dhclient' });
	});

	test('splits pid from program name', () => {
		expect(sockets[0]).toMatchObject({ pid: 800, processName: 'sshd' });
	});
});

describe('parseNetstatWindows', () => {
	const output = [
		'Active Connections',
		'',
		'  Proto  Local Address          Foreign Address        State           PID',
		'  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044',
		'  TCP    [::]:445               [::]:0                 LISTENING       4',
		'  TCP    10.0.0.5:52200         93.184.216.34:443      ESTABLISHED     7320',
		'  UDP    0.0.0.0:5353           *:*                                    3180',
		''
	].join('\n');

	const sockets = parseNetstatWindows(output);

	test('keeps only socket rows', () => {
		expect(sockets).toHaveLength(4);
	});

	test('reads the pid from the state-shifted column per protocol', () => {
		expect(sockets[0]).toMatchObject({ port: 135, state: 'listen', pid: 1044 });
		// UDP rows have no state column, so the pid sits one place to the left.
		expect(sockets[3]).toMatchObject({ protocol: 'udp', port: 5353, pid: 3180, state: 'listen' });
	});

	test('unwraps a bracketed IPv6 address', () => {
		expect(sockets[1]).toMatchObject({ address: '*', port: 445, ipVersion: 'v4' });
	});

	test('records the peer of an established socket', () => {
		expect(sockets[2]).toMatchObject({
			state: 'established',
			peerAddress: '93.184.216.34',
			peerPort: 443
		});
	});

	test('never names a process, leaving that to the process table', () => {
		expect(sockets.every((socket) => socket.processName === null)).toBe(true);
	});
});

describe('parseProcNet', () => {
	// What `grep '' /proc/net/tcp /proc/net/tcp6 …` prints: each line prefixed
	// with the file it came from, which is what names the protocol and family.
	const output = [
		'/proc/net/tcp:  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
		'/proc/net/tcp:   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 14200 1 0000 100 0 0 10 0',
		'/proc/net/tcp:   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 25100 1 0000 100 0 0 10 0',
		'/proc/net/tcp:   2: 0500000A:0016 0900000A:C822 01 00000000:00000000 00:00000000 00000000     0        0 25999 1 0000 20 0 0 10 -1',
		'/proc/net/tcp6:  0: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 14555 1 0000 100 0 0 10 0',
		'/proc/net/tcp6:  1: 0000000000000000FFFF00000100007F:2383 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 30100 1 0000 100 0 0 10 0',
		'/proc/net/udp:  2680: 00000000:0044 00000000:0000 07 00000000:00000000 00:00000000 00000000 0 0 15001 2 0000 0',
		''
	].join('\n');

	const rows = parseProcNet(output);

	test('skips the header and reads every socket', () => {
		expect(rows).toHaveLength(6);
	});

	test('decodes little-endian hex addresses and ports', () => {
		expect(rows[1].socket).toMatchObject({ address: '127.0.0.1', port: 8080, state: 'listen' });
	});

	test('renders an all-zero IPv6 bind as a wildcard, not a stray colon', () => {
		expect(rows[3].socket).toMatchObject({ address: '*', port: 443, ipVersion: 'v6' });
	});

	test('renders a v4-mapped IPv6 address as the address people recognise', () => {
		expect(rows[4].socket).toMatchObject({ address: '127.0.0.1', port: 9091, ipVersion: 'v6' });
	});

	test('reads the peer of an established socket', () => {
		expect(rows[2].socket).toMatchObject({
			state: 'established',
			address: '10.0.0.5',
			peerAddress: '10.0.0.9',
			peerPort: 51234
		});
	});

	test('treats a bound UDP socket as listening whatever its state column says', () => {
		expect(rows[5].socket).toMatchObject({ protocol: 'udp', port: 68, state: 'listen' });
	});

	test('carries the inode, which is the only link back to a process', () => {
		expect(rows.map((row) => row.inode)).toEqual([14200, 25100, 25999, 14555, 30100, 15001]);
	});
});

describe('parseProcFdInodes', () => {
	const output = [
		'/proc/1234/fd/:',
		'lrwx------ 1 deploy deploy 64 Aug 25 09:00 3 -> socket:[25100]',
		'lrwx------ 1 deploy deploy 64 Aug 25 09:00 4 -> /dev/null',
		'',
		'/proc/1300/fd/:',
		'lrwx------ 1 deploy deploy 64 Aug 25 09:00 7 -> socket:[30100]',
		'lrwx------ 1 deploy deploy 64 Aug 25 09:00 8 -> socket:[25100]',
		''
	].join('\n');

	const owners = parseProcFdInodes(output);

	test('maps each socket inode to the process holding it', () => {
		expect(owners.get(25100)).toBe(1234);
		expect(owners.get(30100)).toBe(1300);
	});

	test('credits an inherited socket to the parent, not the forked child', () => {
		// 1300 also holds inode 25100, but 1234 saw it first and is the ancestor.
		expect(owners.get(25100)).toBe(1234);
	});

	test('ignores descriptors that are not sockets', () => {
		expect(owners.size).toBe(2);
	});
});

describe('probe selection on a host with no port tools', () => {
	/** A host where `ss`, `netstat` and `lsof` are all absent. */
	function bareHost(): { runner: CommandRunner; calls: string[] } {
		const calls: string[] = [];
		const runner: CommandRunner = {
			label: 'bare host',
			async run(argv: string[]) {
				const name = argv.find((part) => !part.includes('=') && part !== 'env') ?? argv[0];
				calls.push(name);
				if (name === 'grep') {
					return {
						stdout:
							'/proc/net/tcp:   0: 0100007F:1F90 00000000:0000 0A 0:0 00:0 0 1000 0 25100 1\n',
						stderr: '',
						code: 0
					};
				}
				if (name === 'sh') return { stdout: '', stderr: '', code: 0 };
				return { stdout: '', stderr: 'command not found', code: 127 };
			}
		};
		return { runner, calls };
	}

	test('falls through to the kernel’s own tables and still reports the port', async () => {
		const { runner } = bareHost();
		const scan = await scanSockets(runner, 'linux');

		expect(scan.probe).toBe('/proc/net');
		expect(scan.sockets).toHaveLength(1);
		expect(scan.sockets[0]).toMatchObject({ port: 8080, state: 'listen' });
	});

	test('remembers what worked instead of re-walking the chain every scan', async () => {
		// This is what exhausted an SSH connection: four failing commands per
		// tick, each one a channel, on a host that will never have those tools.
		const { runner, calls } = bareHost();
		const memo = {};

		await scanSockets(runner, 'linux', memo);
		const firstPass = calls.length;
		calls.length = 0;

		await scanSockets(runner, 'linux', memo);

		expect(firstPass).toBeGreaterThan(3);
		expect(calls).not.toContain('ss');
		expect(calls).not.toContain('netstat');
		expect(calls).not.toContain('lsof');
	});

	test('re-derives the probe if the remembered one stops answering', async () => {
		const { runner } = bareHost();
		const memo = {};
		await scanSockets(runner, 'linux', memo);

		// The host changes under us — every probe now fails.
		const dead: CommandRunner = {
			label: 'bare host',
			async run() {
				return { stdout: '', stderr: 'command not found', code: 127 };
			}
		};

		// Re-derivation finds nothing either, and says so rather than reporting
		// an empty table as though the host had no open ports.
		await expect(scanSockets(dead, 'linux', memo)).rejects.toThrow(/Could not read the port table/);
	});
});
