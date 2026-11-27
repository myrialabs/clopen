import { afterEach, describe, expect, test } from 'bun:test';

import { getCleanSpawnEnv } from './env';

const touched = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
	if (!touched.has(key)) touched.set(key, process.env[key]);
	process.env[key] = value;
}

afterEach(() => {
	for (const [key, value] of touched) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	touched.clear();
});

describe('getCleanSpawnEnv', () => {
	test("drops the server's own variables so a nested clopen picks its own port and host", () => {
		setEnv('CLOPEN_HOST', '0.0.0.0');
		setEnv('CLOPEN_PORT', '9200');
		setEnv('CLOPEN_PORT_FRONTEND', '9251');
		setEnv('CLOPEN_PORT_BACKEND', '9261');
		setEnv('CLOPEN_DEBUG', 'true');

		const env = getCleanSpawnEnv();
		expect(env.CLOPEN_HOST).toBeUndefined();
		expect(env.CLOPEN_PORT).toBeUndefined();
		expect(env.CLOPEN_PORT_FRONTEND).toBeUndefined();
		expect(env.CLOPEN_PORT_BACKEND).toBeUndefined();
		expect(env.CLOPEN_DEBUG).toBeUndefined();
	});

	test('drops runtime pollution', () => {
		setEnv('npm_config_user_agent', 'bun/1.3');
		setEnv('VITE_SOMETHING', '1');

		const env = getCleanSpawnEnv();
		expect(env.npm_config_user_agent).toBeUndefined();
		expect(env.VITE_SOMETHING).toBeUndefined();
		expect(env.NODE_ENV).toBeUndefined();
	});

	test("keeps the user's own variables", () => {
		setEnv('MY_TOKEN', 'abc');
		setEnv('CLOPEN_DATA_DIR', '/srv/clopen');

		const env = getCleanSpawnEnv();
		expect(env.MY_TOKEN).toBe('abc');
		expect(env.CLOPEN_DATA_DIR).toBe('/srv/clopen');
	});

	test('removes node_modules entries from PATH', () => {
		const sep = process.platform === 'win32' ? ';' : ':';
		const pathKey = process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH';
		setEnv(pathKey, ['/usr/bin', '/app/node_modules/.bin', '/bin'].join(sep));

		expect(getCleanSpawnEnv()[pathKey]).toBe(['/usr/bin', '/bin'].join(sep));
	});
});
