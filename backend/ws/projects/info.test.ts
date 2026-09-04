import { describe, expect, it } from 'bun:test';
import type { PortEntry, PortOriginKind } from '$shared/types/ports';
import { groupPortsByProject } from './info';

function entry(port: number, kind: PortOriginKind, projectId?: string, publicUrl: string | null = null): PortEntry {
	return {
		key: `tcp:${port}`,
		protocol: 'tcp',
		port,
		addresses: ['127.0.0.1'],
		ipVersions: ['v4'],
		pid: 1000 + port,
		process: null,
		workerPids: [],
		origin: { kind, confidence: 'certain', label: 'Vite dev server', detail: null, projectId },
		peers: [],
		peerCount: 0,
		publicUrl,
		container: null,
		canKill: true,
		killBlockedReason: null
	};
}

describe('groupPortsByProject', () => {
	it('keeps only ports a terminal session owns', () => {
		const grouped = groupPortsByProject([
			entry(5173, 'session', 'project-a'),
			entry(8080, 'external'),
			entry(6379, 'container', 'project-a')
		]);
		expect([...grouped.keys()]).toEqual(['project-a']);
		expect(grouped.get('project-a')?.map((port) => port.port)).toEqual([5173]);
	});

	it('drops a session port that names no project', () => {
		expect(groupPortsByProject([entry(3000, 'session')]).size).toBe(0);
	});

	it('separates ports belonging to different projects', () => {
		const grouped = groupPortsByProject([
			entry(5173, 'session', 'project-a'),
			entry(3000, 'session', 'project-b'),
			entry(4000, 'session', 'project-a')
		]);
		expect(grouped.get('project-a')?.map((port) => port.port)).toEqual([5173, 4000]);
		expect(grouped.get('project-b')?.map((port) => port.port)).toEqual([3000]);
	});

	it('carries the public URL through so a tunnelled port stays reachable', () => {
		const grouped = groupPortsByProject([entry(5173, 'session', 'project-a', 'https://demo.trycloudflare.com')]);
		expect(grouped.get('project-a')?.[0].publicUrl).toBe('https://demo.trycloudflare.com');
	});
});
