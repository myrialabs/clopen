import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { CRYPTO_SUPPORT_METHODS, LINK_SUPPORT_METHODS } from './support';

const readme = readFileSync(join(import.meta.dir, '../../README.md'), 'utf-8');
const supportSection = readme.slice(readme.indexOf('## Support'));

describe('support methods', () => {
	test('every crypto address matches the README Support table', () => {
		for (const method of CRYPTO_SUPPORT_METHODS) {
			expect(supportSection).toContain(`\`${method.address}\``);
		}
	});

	test('every link matches the README Support table', () => {
		for (const method of LINK_SUPPORT_METHODS) {
			expect(supportSection).toContain(`(${method.url})`);
		}
	});

	test('the README lists no address the app is missing', () => {
		const readmeAddresses = [...supportSection.matchAll(/^\|[^|]+\|\s*`([^`]+)`\s*\|/gm)].map(match => match[1]);
		expect(readmeAddresses.sort()).toEqual(CRYPTO_SUPPORT_METHODS.map(method => method.address).sort());
	});
});
