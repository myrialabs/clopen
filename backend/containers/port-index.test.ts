import { describe, expect, test } from 'bun:test';
import type { ContainerScanResult } from '$shared/types/containers';
import { addressesOverlap, containerPortIndex, noteContainerScan } from './port-index';
import { parseDockerPs } from './parse';

function scanOf(listing: string, hostId: string): ContainerScanResult {
	return {
		hostId,
		scannedAt: '2026-08-25T02:02:11.000Z',
		runtime: 'docker',
		runtimeVersion: '27.0.0',
		runtimeProblem: 'none',
		entries: parseDockerPs(listing, hostId),
		images: [],
		volumes: [],
		networks: [],
		limitations: [],
		error: null
	};
}

describe('the index the port table reads', () => {
	const listing = [
		JSON.stringify({
			ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdefabcdef',
			Names: 'shop-api-1',
			Image: 'shop/api:2.1',
			State: 'running',
			Status: 'Up 3 hours',
			Ports: '0.0.0.0:8080->80/tcp, :::8080->80/tcp, 9000/tcp'
		}),
		JSON.stringify({
			ID: 'bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff001122334455',
			Names: 'shop-db-1',
			Image: 'postgres:16',
			State: 'exited',
			Status: 'Exited (0) 4 minutes ago',
			Ports: '0.0.0.0:5432->5432/tcp'
		})
	].join('\n');

	// The index is process-wide state keyed by host, so each test uses its own.
	noteContainerScan(scanOf(listing, 'index-test'));
	const index = containerPortIndex('index-test');

	test('maps a published port to the container that publishes it', () => {
		expect(index.get('tcp:8080')?.ref).toMatchObject({
			name: 'shop-api-1',
			image: 'shop/api:2.1',
			containerPort: 80,
			runtime: 'docker'
		});
	});

	test('carries the address the mapping was published on', () => {
		// One address, not two: the IPv6 twin Docker prints for every published
		// port was already folded into its IPv4 partner when the row was parsed,
		// because they are one mapping to anyone reading the table.
		expect(index.get('tcp:8080')?.addresses).toEqual(['0.0.0.0']);
	});

	test('ignores a port that is exposed but not published — it holds nothing', () => {
		expect(index.has('tcp:9000')).toBe(false);
	});

	test('ignores a stopped container, which is holding no host port at all', () => {
		expect(index.has('tcp:5432')).toBe(false);
	});

	test('reports an empty index for a host that has never been scanned', () => {
		expect(containerPortIndex('never-scanned').size).toBe(0);
	});
});

describe('addressesOverlap', () => {
	test('a wildcard on either side matches anything', () => {
		expect(addressesOverlap(['*'], ['127.0.0.1'])).toBe(true);
		expect(addressesOverlap(['192.168.1.5'], ['0.0.0.0'])).toBe(true);
		expect(addressesOverlap(['::1', '127.0.0.1'], ['::'])).toBe(true);
	});

	test('a shared address matches', () => {
		expect(addressesOverlap(['127.0.0.1', '::1'], ['127.0.0.1'])).toBe(true);
	});

	test('two disjoint addresses do not', () => {
		// A container published on loopback must not claim an unrelated process
		// holding the same port on a LAN address.
		expect(addressesOverlap(['192.168.1.5'], ['127.0.0.1'])).toBe(false);
	});
});
