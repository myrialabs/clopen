import { describe, expect, test } from 'bun:test';
import { parseCpanelQuota, parseFilesystemUsage, parsePosixQuota } from './disk-usage';

const GIGABYTE = 1024 ** 3;

describe('parseCpanelQuota', () => {
	// Captured verbatim from `uapi --output=json Quota get_quota_info` on a real
	// cPanel account — the one whose control panel reads "3.71 GB / 5 GB (74.16%)".
	const REAL_OUTPUT = JSON.stringify({
		apiversion: 3,
		module: 'Quota',
		func: 'get_quota_info',
		result: {
			errors: null,
			data: {
				inodes_used: 243990,
				inodes_remain: '0',
				megabyte_limit: 5120,
				megabytes_used: 3796.91,
				megabytes_remain: 1323.09,
				inode_limit: '0'
			},
			warnings: null,
			messages: null,
			status: 1,
			metadata: {}
		}
	});

	test('reports the account limit, not the filesystem', () => {
		const usage = parseCpanelQuota(REAL_OUTPUT, '/home/user');
		expect(usage).not.toBeNull();
		expect(usage?.source).toBe('account-quota');
		expect(usage?.totalBytes).toBe(5 * GIGABYTE);
	});

	test('the rendered percentage matches what cPanel shows', () => {
		const usage = parseCpanelQuota(REAL_OUTPUT, '/home/user');
		const ratio = (usage!.usedBytes! / usage!.totalBytes!) * 100;
		expect(ratio.toFixed(2)).toBe('74.16');
		expect((usage!.usedBytes! / GIGABYTE).toFixed(2)).toBe('3.71');
	});

	test('carries the inode count', () => {
		const usage = parseCpanelQuota(REAL_OUTPUT, '/home/user');
		expect(usage?.inodesUsed).toBe(243990);
		// cPanel spells "no limit" as 0, which is not a total to divide by.
		expect(usage?.inodeLimit).toBeNull();
	});

	test('an unlimited account reports usage without a total', () => {
		const output = JSON.stringify({
			result: { status: 1, data: { megabytes_used: 120, megabyte_limit: 0 } }
		});
		const usage = parseCpanelQuota(output, '/home/user');
		expect(usage?.totalBytes).toBeNull();
		expect(usage?.usedBytes).toBe(120 * 1024 * 1024);
	});

	test('a failed UAPI call is not an answer', () => {
		const output = JSON.stringify({ result: { status: 0, errors: ['nope'], data: null } });
		expect(parseCpanelQuota(output, '/home/user')).toBeNull();
	});

	test('non-JSON output is not an answer', () => {
		expect(parseCpanelQuota('bash: uapi: command not found', '/home/user')).toBeNull();
		expect(parseCpanelQuota('', '/home/user')).toBeNull();
	});
});

describe('parsePosixQuota', () => {
	const OUTPUT = [
		'Disk quotas for user deploy (uid 1001):',
		'     Filesystem  blocks   quota   limit   grace   files   quota   limit   grace',
		'      /dev/sda1  512000  921600 1048576            4200       0       0'
	].join('\n');

	test('reads the hard limit as the total', () => {
		const usage = parsePosixQuota(OUTPUT, '/home/deploy');
		expect(usage?.source).toBe('user-quota');
		expect(usage?.usedBytes).toBe(512000 * 1024);
		expect(usage?.totalBytes).toBe(1048576 * 1024);
		expect(usage?.availableBytes).toBe((1048576 - 512000) * 1024);
	});

	test('does not guess the file count', () => {
		// `quota -w` prints its grace columns only while over quota, so everything
		// after `limit` shifts position. Reporting nothing beats reporting a number
		// that is silently the wrong column.
		expect(parsePosixQuota(OUTPUT, '/home/deploy')?.inodesUsed).toBeNull();
	});

	test('falls back to the soft limit when there is no hard one', () => {
		const output = OUTPUT.replace('1048576', '0');
		const usage = parsePosixQuota(output, '/home/deploy');
		expect(usage?.totalBytes).toBe(921600 * 1024);
	});

	test('an over-quota asterisk does not break the columns', () => {
		const output = OUTPUT.replace('512000', '999999*');
		const usage = parsePosixQuota(output, '/home/deploy');
		expect(usage?.usedBytes).toBe(999999 * 1024);
	});

	test('no quota set at all is not an answer', () => {
		const output = OUTPUT.replace('921600 1048576', '0       0');
		expect(parsePosixQuota(output, '/home/deploy')).toBeNull();
	});

	test('a host without the quota tool is not an answer', () => {
		expect(parsePosixQuota('', '/home/deploy')).toBeNull();
	});
});

describe('parseFilesystemUsage', () => {
	// The `df` output from the same shared host — 195 GB free on the volume, and
	// the reason `df` alone was the wrong number to show.
	const OUTPUT = [
		'Filesystem     1024-blocks      Used Available Capacity Mounted on',
		'/dev/sdd         762647808 556975748 204879732      74% /home/themeco1'
	].join('\n');

	test('reports the volume, labelled as the volume', () => {
		const usage = parseFilesystemUsage(OUTPUT, '/home/themeco1');
		expect(usage?.source).toBe('filesystem');
		expect(usage?.totalBytes).toBe(762647808 * 1024);
		expect(usage?.availableBytes).toBe(204879732 * 1024);
	});

	test('output with no data line is not an answer', () => {
		expect(parseFilesystemUsage('Filesystem 1024-blocks Used Available', '/')).toBeNull();
		expect(parseFilesystemUsage('', '/')).toBeNull();
	});
});
