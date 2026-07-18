import { spawn } from 'bun';
import { join } from 'path';
import { getClaudeUserConfigDir, getEngineEnv, setupEnvironmentOnce } from './environment';
import { resolveBinaryWithRefresh } from '../../../utils/cli';
import { getClopenDir } from '../../../utils/paths';
import { debug } from '$shared/utils/logger';
import type { UsageSnapshot, UsageQuota } from '$shared/types/unified/engine';

function stripAnsi(text: string): string {
	return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function percentFromLine(line: string): number | null {
	const match = line.match(/([0-9]{1,3})\s*%\s*(used|left)/i);
	if (!match) return null;
	const val = parseInt(match[1], 10);
	const isUsed = match[2].toLowerCase().includes('used');
	return isUsed ? Math.max(0, 100 - val) : val;
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

function extractReset(labelSubstring: string, text: string): string | null {
	const lines = text.split('\n');
	const label = labelSubstring.toLowerCase();

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].toLowerCase().includes(label)) {
			// Search subsequent 14 lines for a reset duration or time
			const window = lines.slice(i, i + 14);
			for (const candidate of window) {
				const lower = candidate.toLowerCase();
				if (lower.includes('reset') || (lower.includes('in') && (lower.includes('h') || lower.includes('m')))) {
					return deduplicateResetText(candidate.trim());
				}
			}
		}
	}
	return null;
}

function deduplicateResetText(text: string): string {
	const matches = [...text.matchAll(/resets/gi)];
	if (matches.length > 1) {
		const lastIdx = matches[matches.length - 1].index;
		if (lastIdx !== undefined) {
			return text.substring(lastIdx).trim();
		}
	}
	return text;
}

function parseResetDate(text: string | null): string | null {
	if (!text) return null;

	const now = new Date();
	let totalSeconds = 0;

	// Extract days
	const dayMatch = text.match(/(\d+)\s*d(?:ays?)?/i);
	if (dayMatch) {
		totalSeconds += parseInt(dayMatch[1], 10) * 24 * 3600;
	}

	// Extract hours
	const hourMatch = text.match(/(\d+)\s*h(?:ours?|r)?/i);
	if (hourMatch) {
		totalSeconds += parseInt(hourMatch[1], 10) * 3600;
	}

	// Extract minutes
	const minMatch = text.match(/(\d+)\s*m(?:in(?:utes?)?)?/i);
	if (minMatch) {
		totalSeconds += parseInt(minMatch[1], 10) * 60;
	}

	if (totalSeconds > 0) {
		return new Date(now.getTime() + totalSeconds * 1000).toISOString();
	}

	// Absolute date/time parser fallback: e.g. "4:59pm (America/New_York)"
	// Strip "resets" and timezone parenthetical
	let cleaned = text.replace(/resets/gi, '');
	cleaned = cleaned.replace(/\s+\d{1,3}%\s*(?:used|left)\s*$/i, ''); // Strip percentage
	cleaned = cleaned.replace(/\s*\([^)]+\)\s*$/i, ''); // Strip (timezone)
	cleaned = cleaned.replace(/\s+at\s+/g, ', ').trim();
	cleaned = cleaned.replace(/(\d+(?::\d+)?)\s*(am|pm)/i, '$1 $2');

	// Parse simple absolute date/time
	const parsed = Date.parse(cleaned);
	if (!isNaN(parsed)) {
		return new Date(parsed).toISOString();
	}

	return null;
}

export async function getClaudeUsage(accountId?: number): Promise<UsageSnapshot> {
	await setupEnvironmentOnce();
	const binary = await resolveBinaryWithRefresh('claude');
	if (!binary) {
		throw new Error('Claude Code binary not found in PATH');
	}

	const configDir = getClaudeUserConfigDir();
	const probeDir = join(getClopenDir(), 'engine', 'claude', 'probe');

	// Ensure probe directory exists
	try {
		await Bun.write(join(probeDir, '.init'), '');
	} catch {
		// Ignore folder creation check
	}

	// Write project trust dialog acceptance to .claude.json in configDir
	const claudeJsonPath = join(configDir, '.claude.json');
	try {
		let configJson: any = {};
		const file = Bun.file(claudeJsonPath);
		if (await file.exists()) {
			configJson = await file.json();
		}
		if (!configJson.projects) {
			configJson.projects = {};
		}
		configJson.projects[probeDir] = { hasTrustDialogAccepted: true };
		await Bun.write(claudeJsonPath, JSON.stringify(configJson, null, 2));
	} catch (err) {
		debug.warn('engine', 'Failed to pre-trust probe folder in claude.json:', err);
	}

	debug.log('engine', `Running claude /usage in directory: ${probeDir}`);
	const env = getEngineEnv(accountId);

	// Run /usage command
	const proc = spawn({
		cmd: [binary, '/usage', '--allowed-tools', ''],
		cwd: probeDir,
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});

	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	const output = stdout + '\n' + stderr;
	const clean = stripAnsi(output);

	debug.log('engine', `Claude usage output:\n${clean}`);

	// Check if payment/api plan indicates usage is not supported via /usage
	if (clean.toLowerCase().includes('/usage is only available for subscription') ||
		clean.toLowerCase().includes('subscription plans') ||
		exitCode !== 0) {
		debug.log('engine', 'Subscription not found or /usage failed, falling back to /cost...');
		// Fallback to /cost
		const costProc = spawn({
			cmd: [binary, '/cost', '--allowed-tools', ''],
			cwd: probeDir,
			env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		await costProc.exited;
		const costStdout = await new Response(costProc.stdout).text();
		const costStderr = await new Response(costProc.stderr).text();
		const costClean = stripAnsi(costStdout + '\n' + costStderr);

		debug.log('engine', `Claude cost output:\n${costClean}`);

		// Cost parser
		const matchCost = costClean.match(/used:\s*\$([0-9.]+)/i);
		const matchBudget = costClean.match(/budget:\s*\$([0-9.]+)/i);
		const costVal = matchCost ? parseFloat(matchCost[1]) : 0;
		const budgetVal = matchBudget ? parseFloat(matchBudget[1]) : 50;

		const percentRemaining = budgetVal > 0 ? Math.max(0, 100 - (costVal / budgetVal) * 100) : 100;
		const quota: UsageQuota = {
			percentRemaining,
			quotaType: 'Monthly Budget',
			providerId: 'claude',
			resetsAt: null,
			resetText: `$${costVal.toFixed(2)} / $${budgetVal.toFixed(2)}`,
		};

		return {
			providerId: 'claude',
			quotas: [quota],
			capturedAt: new Date().toISOString(),
		};
	}

	// Normal subscription usage parser
	const sessionPct = extractPercent('Current session', clean);
	const weeklyPct = extractPercent('Current week (all models)', clean) ?? extractPercent('Current week', clean);
	const opusPct = extractPercent('Current week (Opus)', clean);
	const sonnetPct = extractPercent('Current week (Sonnet)', clean) ?? extractPercent('Current week (Sonnet only)', clean);
	const fablePct = extractPercent('Current week (Fable', clean);

	if (sessionPct === null) {
		throw new Error('Could not find session usage percent in Claude output');
	}

	const sessionReset = extractReset('Current session', clean);
	const weeklyReset = extractReset('Current week', clean);

	const quotas: UsageQuota[] = [];

	quotas.push({
		percentRemaining: sessionPct,
		quotaType: 'Session',
		providerId: 'claude',
		resetsAt: parseResetDate(sessionReset),
		resetText: sessionReset || undefined,
	});

	if (weeklyPct !== null) {
		quotas.push({
			percentRemaining: weeklyPct,
			quotaType: 'Weekly (All)',
			providerId: 'claude',
			resetsAt: parseResetDate(weeklyReset),
			resetText: weeklyReset || undefined,
		});
	}

	if (opusPct !== null) {
		quotas.push({
			percentRemaining: opusPct,
			quotaType: 'Weekly (Opus)',
			providerId: 'claude',
			resetsAt: parseResetDate(weeklyReset),
			resetText: weeklyReset || undefined,
		});
	}

	if (sonnetPct !== null) {
		quotas.push({
			percentRemaining: sonnetPct,
			quotaType: 'Weekly (Sonnet)',
			providerId: 'claude',
			resetsAt: parseResetDate(weeklyReset),
			resetText: weeklyReset || undefined,
		});
	}

	if (fablePct !== null) {
		const fableReset = extractReset('Current week (Fable', clean) || weeklyReset;
		quotas.push({
			percentRemaining: fablePct,
			quotaType: 'Weekly (Fable)',
			providerId: 'claude',
			resetsAt: parseResetDate(fableReset),
			resetText: fableReset || undefined,
		});
	}

	return {
		providerId: 'claude',
		quotas,
		capturedAt: new Date().toISOString(),
	};
}

export const _test = {
	stripAnsi,
	percentFromLine,
	extractPercent,
	extractReset,
	deduplicateResetText,
	parseResetDate
};

