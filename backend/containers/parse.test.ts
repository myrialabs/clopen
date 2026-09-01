import { describe, expect, test } from 'bun:test';
import {
	healthFrom,
	linkUsage,
	normaliseState,
	parseDiskUsage,
	parseDockerNetworks,
	parseNetworkMembership,
	parsePodmanNetworks,
	parsePruneOutput,
	parseStats,
	parseDockerImages,
	parseDockerPortsField,
	parseDockerPs,
	parseDockerVolumes,
	parseInspect,
	parseMounts,
	parsePodmanImages,
	parsePodmanPs,
	parsePodmanVolumes,
	parseTimestamp
} from './parse';

/**
 * Fixtures are shaped like real runtime output but describe an invented host,
 * so nothing about a contributor's own machine ends up in the repository.
 */

describe('parseTimestamp', () => {
	test('reads Docker’s Go layout, dropping the zone abbreviation nothing can parse', () => {
		expect(parseTimestamp('2026-08-25 09:02:11 +0700 WIB')).toBe('2026-08-25T02:02:11.000Z');
	});

	test('reads RFC 3339 as Podman prints it', () => {
		expect(parseTimestamp('2026-08-25T09:02:11.123456789+07:00')).toBe('2026-08-25T02:02:11.123Z');
	});

	test('reads a Unix epoch in seconds and in milliseconds', () => {
		expect(parseTimestamp(1787_000_000)).toBe(new Date(1787_000_000_000).toISOString());
		expect(parseTimestamp(1787_000_000_000)).toBe(new Date(1787_000_000_000).toISOString());
	});

	test('reports nothing rather than a wrong date', () => {
		expect(parseTimestamp('mar. août 25 09:02:11 2026')).toBeNull();
		expect(parseTimestamp('')).toBeNull();
		expect(parseTimestamp(null)).toBeNull();
		// Go's zero time, which both runtimes print for a container never started.
		expect(parseTimestamp('0001-01-01T00:00:00Z')).toBeNull();
	});
});

describe('normaliseState', () => {
	test('takes the runtime’s own word when there is one', () => {
		expect(normaliseState('running', '')).toBe('running');
		expect(normaliseState('exited', '')).toBe('exited');
	});

	test('translates Podman’s vocabulary', () => {
		expect(normaliseState('stopped', '')).toBe('exited');
		expect(normaliseState('configured', '')).toBe('created');
	});

	test('falls back to the status text, for a Docker too old to have a State column', () => {
		expect(normaliseState(null, 'Up 3 hours (healthy)')).toBe('running');
		expect(normaliseState(null, 'Up 2 days (Paused)')).toBe('paused');
		expect(normaliseState(null, 'Exited (0) 4 minutes ago')).toBe('exited');
	});

	test('says unknown rather than guessing', () => {
		expect(normaliseState('teleporting', 'something else')).toBe('unknown');
	});
});

describe('healthFrom', () => {
	test('reads the verdict out of the status text', () => {
		expect(healthFrom('Up 3 hours (healthy)')).toBe('healthy');
		expect(healthFrom('Up 3 hours (unhealthy)')).toBe('unhealthy');
		expect(healthFrom('Up 8 seconds (health: starting)')).toBe('starting');
	});

	test('prefers an explicit field when the runtime provides one', () => {
		expect(healthFrom(null, 'unhealthy')).toBe('unhealthy');
	});

	test('says none when the image declares no healthcheck', () => {
		expect(healthFrom('Up 3 hours')).toBe('none');
	});
});

describe('parseDockerPortsField', () => {
	test('reads a published mapping', () => {
		expect(parseDockerPortsField('0.0.0.0:8080->80/tcp')).toEqual([
			{ hostAddress: '0.0.0.0', hostPort: 8080, containerPort: 80, protocol: 'tcp' }
		]);
	});

	test('folds the IPv6 twin of a mapping into one binding', () => {
		const bindings = parseDockerPortsField('0.0.0.0:8080->80/tcp, :::8080->80/tcp');
		expect(bindings).toHaveLength(1);
		expect(bindings[0].hostAddress).toBe('0.0.0.0');
	});

	test('expands a published range so no reachable port is hidden', () => {
		const bindings = parseDockerPortsField('0.0.0.0:8000-8002->8000-8002/tcp');
		expect(bindings.map((binding) => binding.hostPort)).toEqual([8000, 8001, 8002]);
	});

	test('keeps a port exposed but not published, with no host port', () => {
		expect(parseDockerPortsField('9000/tcp')).toEqual([
			{ hostAddress: null, hostPort: null, containerPort: 9000, protocol: 'tcp' }
		]);
	});

	test('reads udp and a loopback-only binding', () => {
		expect(parseDockerPortsField('127.0.0.1:5353->53/udp')).toEqual([
			{ hostAddress: '127.0.0.1', hostPort: 5353, containerPort: 53, protocol: 'udp' }
		]);
	});

	test('reports nothing for an empty column', () => {
		expect(parseDockerPortsField('')).toEqual([]);
		expect(parseDockerPortsField(null)).toEqual([]);
	});
});

describe('parseDockerPs', () => {
	const output = [
		JSON.stringify({
			ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdefabcdef',
			Names: 'shop-api-1',
			Image: 'shop/api:2.1',
			State: 'running',
			Status: 'Up 3 hours (healthy)',
			Ports: '0.0.0.0:8080->80/tcp, :::8080->80/tcp',
			CreatedAt: '2026-08-25 09:02:11 +0700 WIB',
			Labels: 'com.docker.compose.project=shop,com.docker.compose.service=api',
			Command: '"nginx -g daemon off;"',
			Mounts: 'shop-assets'
		}),
		JSON.stringify({
			ID: 'bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff001122334455',
			Names: 'shop-db-1',
			Image: 'postgres:16',
			State: 'exited',
			Status: 'Exited (0) 4 minutes ago',
			Ports: '',
			CreatedAt: '2026-08-24 18:40:00 +0700 WIB',
			Labels: 'com.docker.compose.project=shop,com.docker.compose.service=db',
			Command: '"postgres"',
			Mounts: 'shop-data'
		}),
		'a warning the daemon printed on its way out',
		''
	].join('\n');

	const entries = parseDockerPs(output, 'local');

	test('reads every container and ignores anything that is not a row', () => {
		expect(entries).toHaveLength(2);
	});

	test('keys the row by host and id, so two hosts never collide', () => {
		expect(entries[0].key).toBe(`local:${entries[0].id}`);
		expect(entries[0].shortId).toBe('a1b2c3d4e5f6');
	});

	test('reads state, health and the compose labels', () => {
		expect(entries[0]).toMatchObject({
			name: 'shop-api-1',
			image: 'shop/api:2.1',
			state: 'running',
			health: 'healthy',
			composeProject: 'shop',
			composeService: 'api'
		});
	});

	test('reads the published port, folded across address families', () => {
		expect(entries[0].ports).toEqual([
			{ hostAddress: '0.0.0.0', hostPort: 8080, containerPort: 80, protocol: 'tcp' }
		]);
	});

	test('leaves a stopped container with no start time rather than inventing one', () => {
		expect(entries[1]).toMatchObject({ state: 'exited', startedAt: null, ports: [] });
	});
});

describe('parsePodmanPs', () => {
	const output = JSON.stringify([
		{
			Id: 'cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233445566aa',
			Names: ['shop-api'],
			Image: 'docker.io/shop/api:2.1',
			State: 'running',
			Status: '',
			StartedAt: 1787_000_000,
			Created: '2026-08-25T09:02:11.123456789+07:00',
			Command: ['nginx', '-g', 'daemon off;'],
			Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'api' },
			Ports: [{ host_ip: '0.0.0.0', container_port: 80, host_port: 8080, range: 1, protocol: 'tcp' }],
			Mounts: ['shop-assets'],
			IsInfra: false
		},
		{
			Id: 'dd44ee55ff6600112233445566778899aabbccddeeff00112233445566aabbcc',
			Names: ['shop-pod-infra'],
			Image: 'localhost/podman-pause:5.0',
			State: 'running',
			IsInfra: true
		}
	]);

	const entries = parsePodmanPs(output, 'vps-1');

	test('drops the pod infra container, which is plumbing rather than a workload', () => {
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe('shop-api');
	});

	test('joins the argv Podman reports as an array', () => {
		expect(entries[0].command).toBe('nginx -g daemon off;');
	});

	test('reads structured ports', () => {
		expect(entries[0].ports).toEqual([
			{ hostAddress: '0.0.0.0', hostPort: 8080, containerPort: 80, protocol: 'tcp' }
		]);
	});

	test('writes a status line when Podman leaves the field empty', () => {
		expect(entries[0].statusText.startsWith('Up ')).toBe(true);
	});

	test('expands Podman’s port range shorthand', () => {
		const ranged = parsePodmanPs(
			JSON.stringify([
				{
					Id: 'ee55ff6600112233445566778899aabbccddeeff00112233445566aabbccdd11',
					Names: ['range-demo'],
					Image: 'demo',
					State: 'running',
					Ports: [{ host_ip: '', container_port: 8000, host_port: 8000, range: 3, protocol: 'tcp' }]
				}
			]),
			'vps-1'
		);
		expect(ranged[0].ports.map((port) => port.hostPort)).toEqual([8000, 8001, 8002]);
	});
});

describe('images and volumes', () => {
	test('reads Docker’s image rows and marks the danglers', () => {
		const images = parseDockerImages(
			[
				JSON.stringify({
					ID: 'sha256:aaa111',
					Repository: 'shop/api',
					Tag: '2.1',
					Size: '184MB',
					CreatedAt: '2026-08-20 11:00:00 +0700 WIB'
				}),
				JSON.stringify({ ID: 'sha256:bbb222', Repository: '<none>', Tag: '<none>', Size: '92MB' })
			].join('\n')
		);
		expect(images).toHaveLength(2);
		expect(images[0]).toMatchObject({ repository: 'shop/api', tag: '2.1', dangling: false });
		expect(images[1].dangling).toBe(true);
	});

	test('splits Podman’s fully qualified names into repository and tag', () => {
		const images = parsePodmanImages(
			JSON.stringify([
				{ Id: 'aaa111', Names: ['docker.io/shop/api:2.1'], Size: 184_000_000, Created: 1787_000_000 },
				{ Id: 'ccc333', Names: ['localhost:5000/internal/tool'], Size: 1_000 }
			])
		);
		expect(images[0]).toMatchObject({ repository: 'docker.io/shop/api', tag: '2.1', size: '184MB' });
		// A registry port is not a tag: `localhost:5000/internal/tool` has none.
		expect(images[1]).toMatchObject({ repository: 'localhost:5000/internal/tool', tag: 'latest' });
	});

	test('reads volumes from either runtime', () => {
		expect(
			parseDockerVolumes(JSON.stringify({ Name: 'shop-data', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/shop-data/_data' }))
		).toEqual([
			{
				key: 'shop-data',
				name: 'shop-data',
				driver: 'local',
				mountpoint: '/var/lib/docker/volumes/shop-data/_data',
				createdAt: null,
				usedBy: []
			}
		]);

		expect(
			parsePodmanVolumes(
				JSON.stringify([{ Name: 'shop-data', Driver: 'local', Mountpoint: '/home/deploy/.local/share/containers/storage/volumes/shop-data/_data', CreatedAt: '2026-08-01T10:00:00Z' }])
			)[0]
		).toMatchObject({ name: 'shop-data', createdAt: '2026-08-01T10:00:00.000Z' });
	});
});

describe('linkUsage', () => {
	test('names the containers using each image and volume', () => {
		const listing = JSON.stringify({
			ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdefabcdef',
			Names: 'shop-api-1',
			Image: 'shop/api:2.1',
			State: 'running',
			Status: 'Up 3 hours',
			Mounts: 'shop-assets,shop-data'
		});
		const entries = parseDockerPs(listing, 'local');
		const images = parseDockerImages(
			JSON.stringify({ ID: 'sha256:aaa111', Repository: 'shop/api', Tag: '2.1', Size: '184MB' })
		);
		const volumes = parseDockerVolumes(
			[
				JSON.stringify({ Name: 'shop-assets', Driver: 'local' }),
				JSON.stringify({ Name: 'orphan-cache', Driver: 'local' })
			].join('\n')
		);

		linkUsage(entries, images, volumes, parseMounts(listing, 'docker'));

		expect(images[0].usedBy).toEqual(['shop-api-1']);
		expect(volumes[0].usedBy).toEqual(['shop-api-1']);
		expect(volumes[1].usedBy).toEqual([]);
	});

	test('matches a Podman image name against a container’s fully qualified one', () => {
		const entries = parsePodmanPs(
			JSON.stringify([
				{
					Id: 'cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233445566aa',
					Names: ['shop-api'],
					Image: 'docker.io/shop/api:2.1',
					State: 'running'
				}
			]),
			'vps-1'
		);
		const images = parsePodmanImages(
			JSON.stringify([{ Id: 'aaa111', Names: ['shop/api:2.1'], Size: 1000 }])
		);

		linkUsage(entries, images, [], new Map());
		expect(images[0].usedBy).toEqual(['shop-api']);
	});
});

describe('parseInspect', () => {
	const output = JSON.stringify({
		Id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdefabcdef',
		Name: '/shop-api-1',
		Created: '2026-08-25T02:02:11.000Z',
		Image: 'sha256:aaa111',
		RestartCount: 2,
		Path: '/docker-entrypoint.sh',
		State: {
			Status: 'running',
			Running: true,
			StartedAt: '2026-08-25T02:02:12.000Z',
			FinishedAt: '0001-01-01T00:00:00Z',
			ExitCode: 0,
			Pid: 4210,
			Health: { Status: 'healthy' }
		},
		Config: {
			Image: 'shop/api:2.1',
			Cmd: ['nginx', '-g', 'daemon off;'],
			Env: ['NODE_ENV=production'],
			WorkingDir: '/srv/app',
			User: 'app',
			Labels: { 'com.docker.compose.project': 'shop' }
		},
		HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
		NetworkSettings: {
			Networks: { shop_default: { IPAddress: '172.19.0.4' } },
			Ports: {
				'80/tcp': [
					{ HostIp: '0.0.0.0', HostPort: '8080' },
					{ HostIp: '::', HostPort: '8080' }
				],
				'9000/tcp': null
			}
		},
		Mounts: [{ Type: 'volume', Name: 'shop-assets', Source: '/var/lib/docker/volumes/shop-assets/_data', Destination: '/srv/app/public', RW: true }]
	});

	const detail = parseInspect(output);

	test('reads the container, with the slash Docker prefixes its name with removed', () => {
		expect(detail?.name).toBe('shop-api-1');
	});

	test('reads state, health, pid and restart policy', () => {
		expect(detail).toMatchObject({
			state: 'running',
			health: 'healthy',
			pid: 4210,
			restartCount: 2,
			restartPolicy: 'unless-stopped',
			workingDir: '/srv/app',
			user: 'app'
		});
	});

	test('reports Go’s zero time as no finish time at all', () => {
		expect(detail?.finishedAt).toBeNull();
		expect(detail?.startedAt).toBe('2026-08-25T02:02:12.000Z');
	});

	test('reads published and merely exposed ports, folding the address families', () => {
		expect(detail?.ports).toEqual([
			{ hostAddress: '0.0.0.0', hostPort: 8080, containerPort: 80, protocol: 'tcp' },
			{ hostAddress: null, hostPort: null, containerPort: 9000, protocol: 'tcp' }
		]);
	});

	test('reads networks and mounts', () => {
		expect(detail?.networks).toEqual([{ name: 'shop_default', ipAddress: '172.19.0.4' }]);
		expect(detail?.mounts[0]).toMatchObject({
			destination: '/srv/app/public',
			readOnly: false,
			kind: 'volume'
		});
	});

	test('reports nothing for output that names no container', () => {
		expect(parseInspect('')).toBeNull();
		expect(parseInspect('[]')).toBeNull();
	});
});

describe('networks', () => {
	test('reads Docker’s network rows and marks the runtime’s own', () => {
		const networks = parseDockerNetworks(
			[
				JSON.stringify({
					ID: '52048fed8d9d867057ed8a5f05cfad27ac99835640e621b2b844aba0292d21a0',
					Name: 'shop_default',
					Driver: 'bridge',
					Scope: 'local',
					Internal: 'false',
					CreatedAt: '2026-05-15 15:40:00.397 +0700 WIB'
				}),
				JSON.stringify({ ID: '5f57c31f263f', Name: 'bridge', Driver: 'bridge', Scope: 'local' })
			].join('\n')
		);

		expect(networks[0]).toMatchObject({
			name: 'shop_default',
			driver: 'bridge',
			internal: false,
			predefined: false
		});
		// `bridge` cannot be removed on any host, so it is never offered as such.
		expect(networks[1].predefined).toBe(true);
	});

	test('reads Podman’s lower-case field names', () => {
		const networks = parsePodmanNetworks(
			JSON.stringify([
				{ name: 'shop_default', id: 'aa11bb22', driver: 'bridge', created: '2026-05-15T15:40:00Z' },
				{ name: 'podman', id: 'cc33dd44', driver: 'bridge' }
			])
		);
		expect(networks[0]).toMatchObject({ name: 'shop_default', id: 'aa11bb22', predefined: false });
		expect(networks[1].predefined).toBe(true);
	});

	test('names the containers attached to each network', () => {
		const listing = JSON.stringify({
			ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdefabcdef',
			Names: 'shop-api-1',
			Image: 'shop/api:2.1',
			State: 'running',
			Status: 'Up 3 hours',
			Networks: 'shop_default'
		});
		const entries = parseDockerPs(listing, 'local');
		const networks = parseDockerNetworks(
			[
				JSON.stringify({ ID: 'aa11', Name: 'shop_default', Driver: 'bridge' }),
				JSON.stringify({ ID: 'bb22', Name: 'orphan_net', Driver: 'bridge' })
			].join('\n')
		);

		linkUsage(entries, [], [], new Map(), networks, parseNetworkMembership(listing, 'docker'));

		expect(networks[0].usedBy).toEqual(['shop-api-1']);
		expect(networks[1].usedBy).toEqual([]);
	});
});

describe('parsePruneOutput', () => {
	test('reads what Docker removed and the space it freed', () => {
		const output = [
			'Deleted Volumes:',
			'shop-cache',
			'a78f6fd7e8b9d8bd121d1e36bb05900293bd4c6f30f9a3565b2bf96c3294fced',
			'',
			'Total reclaimed space: 1.24GB'
		].join('\n');
		expect(parsePruneOutput(output)).toEqual({ removed: 2, reclaimed: '1.24GB' });
	});

	test('does not count an untag as a deletion', () => {
		// `image prune` lists the tag it dropped beside the layer it deleted;
		// counting both would report twice as much work as it did.
		const output = [
			'Deleted Images:',
			'untagged: shop/api:2.1',
			'deleted: sha256:aaa111',
			'',
			'Total reclaimed space: 184MB'
		].join('\n');
		expect(parsePruneOutput(output)).toEqual({ removed: 1, reclaimed: '184MB' });
	});

	test('reports no space rather than a made-up figure when the runtime is silent', () => {
		// Podman prints the ids it removed and nothing else.
		expect(parsePruneOutput('aa11bb22\ncc33dd44\n')).toEqual({ removed: 2, reclaimed: null });
	});

	test('reads a sweep that found nothing', () => {
		expect(parsePruneOutput('Total reclaimed space: 0B\n')).toEqual({
			removed: 0,
			reclaimed: '0B'
		});
	});
});

describe('parseDiskUsage', () => {
	test('reads Docker’s four resource lines', () => {
		const usage = parseDiskUsage(
			[
				JSON.stringify({ Type: 'Images', TotalCount: '66', Active: '19', Size: '32.91GB', Reclaimable: '12.27GB (37%)' }),
				JSON.stringify({ Type: 'Containers', TotalCount: '23', Active: '9', Size: '840.6MB', Reclaimable: '702MB (83%)' }),
				JSON.stringify({ Type: 'Local Volumes', TotalCount: '327', Active: '13', Size: '25.16GB', Reclaimable: '24.47GB (97%)' }),
				JSON.stringify({ Type: 'Build Cache', TotalCount: '38', Active: '0', Size: '1.969GB', Reclaimable: '1.24GB' })
			].join('\n'),
			'docker'
		);

		expect(usage.rows.map((row) => row.kind)).toEqual([
			'images',
			'containers',
			'volumes',
			'build-cache'
		]);
		expect(usage.rows[2]).toMatchObject({ total: 327, active: 13, reclaimable: '24.47GB (97%)' });
	});

	test('formats Podman’s raw byte counts', () => {
		const usage = parseDiskUsage(
			JSON.stringify([{ Type: 'Images', Total: 5, Active: 2, Size: 184_000_000, Reclaimable: 92_000_000 }]),
			'podman'
		);
		expect(usage.rows[0]).toMatchObject({ kind: 'images', size: '184MB', reclaimable: '92MB' });
	});
});

describe('parseStats', () => {
	test('reads a Docker sample', () => {
		const stats = parseStats(
			JSON.stringify({
				BlockIO: '17MB / 120MB',
				CPUPerc: '0.05%',
				MemPerc: '1.84%',
				MemUsage: '36.12MiB / 1.913GiB',
				NetIO: '878kB / 2.18MB',
				PIDs: '6'
			})
		);
		expect(stats).toEqual({
			cpuPercent: 0.05,
			memoryUsage: '36.12MiB / 1.913GiB',
			memoryPercent: 1.84,
			networkIO: '878kB / 2.18MB',
			blockIO: '17MB / 120MB',
			pids: 6
		});
	});

	test('joins the usage and limit Podman reports separately', () => {
		const stats = parseStats(
			JSON.stringify([{ cpu_percent: '1.20%', mem_usage: '36MB', MemLimit: '2GB', pids: 6 }])
		);
		expect(stats).toMatchObject({ cpuPercent: 1.2, memoryUsage: '36MB / 2GB', pids: 6 });
	});

	test('reports nothing for a container that gave no sample', () => {
		expect(parseStats('')).toBeNull();
	});
});
