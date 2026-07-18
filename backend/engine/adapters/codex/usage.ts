import { spawn } from 'bun';
import { join } from 'path';
import { engineQueries } from '../../../database/queries';
import { resolveBinaryWithRefresh } from '../../../utils/cli';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { applyAccountAuth } from './credential';
import { debug } from '$shared/utils/logger';
import type { UsageSnapshot, UsageQuota } from '$shared/types/unified/engine';

function stripAnsi(text: string): string {
	return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function percentFromLine(line: string): number | null {
	const match = line.match(/([0-9]{1,3})\s*%\s*left/i);
	if (!match) return null;
	return parseInt(match[1], 10);
}

function extractPercent(labelSubstring: string, text: string): number | null {
	const lines = text.split('\n');
	const label = labelSubstring.toLowerCase();

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].toLowerCase().includes(label)) {
			// Search subsequent 12 lines for a percentage
			const window = lines.slice(i, i + 12);
			for (const candidate of window) {
				const pct = percentFromLine(candidate);
				if (pct !== null) {
					return pct;
				}
			}
		}
	}
	return null;
}

export async function getCodexUsage(accountId?: number): Promise<UsageSnapshot> {
	const account = accountId !== undefined
		? engineQueries.getAccount(accountId)
		: engineQueries.getActiveAccountForEngine('codex');

	if (!account) {
		throw new Error('Codex account not found');
	}

	// Apply auth to disk (for chatgpt mode)
	applyAccountAuth(account);

	const binary = await resolveBinaryWithRefresh('codex');
	if (!binary) {
		throw new Error('Codex CLI binary not found in PATH');
	}

	const codexHome = getEngineUserConfigDir('codex');
	debug.log('engine', `Running codex with status query in CODEX_HOME: ${codexHome}`);

	// Run codex CLI in read-only and untrusted mode, passing /status to stdin
	const proc = spawn({
		cmd: [binary, '-s', 'read-only', '-a', 'untrusted'],
		cwd: codexHome,
		env: {
			...process.env,
			CODEX_HOME: codexHome
		},
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});

	// Write /status and exit
	if (proc.stdin) {
		proc.stdin.write('/status\n');
		proc.stdin.write('/quit\n');
		proc.stdin.end();
	}

	await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	const output = stdout + '\n' + stderr;
	const clean = stripAnsi(output);

	debug.log('engine', `Codex status output:\n${clean}`);

	// Check for errors
	const lower = clean.toLowerCase();
	if (lower.includes('not logged in') || lower.includes('please log in')) {
		throw new Error('Codex: not logged in or token expired');
	}

	// Parse percentages
	const fiveHourPct = extractPercent('5h limit', clean);
	const weeklyPct = extractPercent('Weekly limit', clean);

	const quotas: UsageQuota[] = [];

	if (fiveHourPct !== null) {
		quotas.push({
			percentRemaining: fiveHourPct,
			quotaType: '5h Limit',
			providerId: 'codex',
			resetsAt: null,
			resetText: `${fiveHourPct}% remaining`
		});
	}

	if (weeklyPct !== null) {
		quotas.push({
			percentRemaining: weeklyPct,
			quotaType: 'Weekly Limit',
			providerId: 'codex',
			resetsAt: null,
			resetText: `${weeklyPct}% remaining`
		});
	}

	if (quotas.length === 0) {
		// If limits not found (common for API key mode where limits don't apply)
		quotas.push({
			percentRemaining: 100,
			quotaType: 'Session',
			providerId: 'codex',
			resetsAt: null,
			resetText: 'Unlimited quota'
		});
	}

	return {
		providerId: 'codex',
		quotas,
		capturedAt: new Date().toISOString()
	};
}
