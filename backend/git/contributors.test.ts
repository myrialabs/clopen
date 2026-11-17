import { describe, expect, test } from 'bun:test';

import type { GitCommit } from '$shared/types/git';
import { aggregateContributors, contributorKey } from './contributors';

const commit = (author: string, authorEmail: string, date: string): GitCommit => ({
	hash: `${author}-${date}`,
	hashShort: 'abc',
	author,
	authorEmail,
	date,
	message: 'm',
	parents: [],
	refs: []
});

describe('aggregateContributors', () => {
	test('groups one person across display names by email, most commits first', () => {
		const result = aggregateContributors([
			commit('Arga', 'Arga@Example.com', '2026-11-03T10:00:00+07:00'),
			commit('Bot', 'bot@example.com', '2026-11-02T10:00:00+07:00'),
			commit('Arga Fairuz ', 'arga@example.com', '2026-11-05T10:00:00+07:00'),
			commit('Bot', 'bot@example.com', '2026-11-01T10:00:00+07:00'),
			commit('Arga', 'arga@example.com', '2026-11-01T10:00:00+07:00')
		]);
		expect(result).toEqual([
			{ key: 'arga@example.com', name: 'Arga', email: 'Arga@Example.com', count: 3, lastDate: '2026-11-05T10:00:00+07:00' },
			{ key: 'bot@example.com', name: 'Bot', email: 'bot@example.com', count: 2, lastDate: '2026-11-02T10:00:00+07:00' }
		]);
	});

	test('falls back to the author name when there is no email', () => {
		expect(contributorKey({ author: ' Someone ', authorEmail: '' })).toBe('someone');
	});
});
