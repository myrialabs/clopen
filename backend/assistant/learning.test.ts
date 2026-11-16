import { describe, expect, it } from 'bun:test';
import { normaliseCommand, promptTokens, scriptFromCommands, sequencesOf, similarity } from './learning';

describe('normaliseCommand', () => {
	it('keeps commands that do something, without plumbing', () => {
		expect(normaliseCommand('cd /repo && bun run check 2>&1 | tail -20')).toBe('bun run check');
		expect(normaliseCommand('pkill -f "next dev"')).toBe('pkill -f "next dev"');
	});

	it('drops reading, inspecting and multi-line commands', () => {
		for (const raw of ['ls -la', 'cat package.json', 'grep -rn foo src', 'git status --short', 'sed -n 1,80p file.ts', "python3 - <<'EOF'"]) {
			expect(normaliseCommand(raw)).toBeNull();
		}
		expect(normaliseCommand('bun run check\nbun run lint')).toBeNull();
	});
});

describe('sequencesOf', () => {
	it('lists every run of two to four distinct consecutive commands', () => {
		const runs = sequencesOf(['a', 'b', 'c']).map((run) => run.join(','));
		expect(runs.sort()).toEqual(['a,b', 'a,b,c', 'b,c'].sort());
	});

	it('skips runs that repeat a command', () => {
		expect(sequencesOf(['a', 'a'])).toEqual([]);
	});
});

describe('scriptFromCommands', () => {
	it('stops at the first failure', () => {
		expect(scriptFromCommands(['bun run check', 'bun run test'])).toContain('set -euo pipefail');
	});
});

describe('prompt similarity', () => {
	it('recognises the same request worded slightly differently', () => {
		const a = promptTokens('cek PR https://github.com/x/y/pull/1 dan perbaiki yang tidak tepat, pastikan cross-platform');
		const b = promptTokens('cek PR https://github.com/x/y/pull/2 dan perbaiki yang tidak tepat, pastikan cross-platform juga');
		expect(similarity(a, b)).toBeGreaterThanOrEqual(0.55);
	});

	it('tells different requests apart', () => {
		const a = promptTokens('buatkan landing page untuk kafe dengan menu dan form kontak');
		const b = promptTokens('perbaiki migrasi database yang gagal di tabel users');
		expect(similarity(a, b)).toBeLessThan(0.2);
	});
});
