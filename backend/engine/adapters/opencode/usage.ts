import { spawn } from 'bun';
import { resolveBinaryWithRefresh } from '../../../utils/cli';
import { debug } from '$shared/utils/logger';
import type { UsageSnapshot, UsageQuota } from '$shared/types/unified/engine';

const fiveHourLimit = 12.0;
const weeklyLimit = 30.0;
const monthlyLimit = 60.0;

function percentRemaining(used: number, limit: number): number {
	if (limit <= 0) return 100;
	return Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
}

function startOfWeekUTC(date: Date): Date {
	const result = new Date(date);
	const day = result.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
	const diff = result.getUTCDate() - day + (day === 0 ? -6 : 1); // Adjust when day is sunday
	result.setUTCDate(diff);
	result.setUTCHours(0, 0, 0, 0);
	return result;
}

function endOfWeekUTC(date: Date): Date {
	const start = startOfWeekUTC(date);
	return new Date(start.getTime() + 7 * 24 * 3600 * 1000);
}

function anchoredMonthBounds(now: Date, anchor: Date): { start: Date; end: Date } {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), anchor.getUTCDate(), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
	if (start > now) {
		start.setUTCMonth(start.getUTCMonth() - 1);
	}
	const end = new Date(start);
	end.setUTCMonth(end.getUTCMonth() + 1);
	return { start, end };
}

async function runDBQuery(opencodeBin: string, sql: string): Promise<any[]> {
	const proc = spawn({
		cmd: [opencodeBin, 'db', sql, '--format', 'json'],
		stdout: 'pipe',
		stderr: 'pipe',
	});

	await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	if (proc.exitCode !== 0) {
		throw new Error(`OpenCode db command failed (exit ${proc.exitCode}): ${stderr}`);
	}

	try {
		return JSON.parse(stdout.trim() || '[]');
	} catch (err) {
		throw new Error(`Failed to parse OpenCode db JSON output: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function getOpenCodeUsage(): Promise<UsageSnapshot> {
	const binary = await resolveBinaryWithRefresh('opencode');
	if (!binary) {
		throw new Error('OpenCode CLI binary not found in PATH');
	}

	const now = new Date();
	const nowMs = now.getTime();
	const fiveHourMs = nowMs - 5 * 3600 * 1000;
	const weekStart = startOfWeekUTC(now);
	const weekEnd = endOfWeekUTC(now);

	const subquery = `
		SELECT
			CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS t,
			CAST(json_extract(data, '$.cost') AS REAL) AS cost
		FROM message
		WHERE json_valid(data)
			AND json_extract(data, '$.providerID') = 'opencode-go'
			AND json_extract(data, '$.role') = 'assistant'
			AND json_type(data, '$.cost') IN ('integer', 'real')
	`;

	const primarySQL = `
		SELECT
			COALESCE(SUM(CASE WHEN t >= ${fiveHourMs} THEN cost ELSE 0 END), 0) AS five_hour_cost,
			COALESCE(SUM(CASE WHEN t >= ${weekStart.getTime()} THEN cost ELSE 0 END), 0) AS weekly_cost,
			MIN(CASE WHEN t >= ${fiveHourMs} THEN t ELSE NULL END) AS five_hour_oldest_ms,
			MIN(t) AS anchor_ms
		FROM (${subquery})
	`;

	debug.log('engine', 'Running OpenCode primary SQL query...');
	const primaryRows = await runDBQuery(binary, primarySQL);
	const primary = primaryRows[0] || {
		five_hour_cost: 0,
		weekly_cost: 0,
		five_hour_oldest_ms: null,
		anchor_ms: null,
	};

	let monthlyCost = 0;
	let monthEnd = new Date(nowMs + 30 * 24 * 3600 * 1000);

	if (primary.anchor_ms !== null) {
		const anchor = new Date(primary.anchor_ms);
		const bounds = anchoredMonthBounds(now, anchor);
		monthEnd = bounds.end;

		const monthlySQL = `
			SELECT COALESCE(SUM(cost), 0) AS monthly_cost
			FROM (${subquery})
			WHERE t >= ${bounds.start.getTime()} AND t < ${bounds.end.getTime()}
		`;

		debug.log('engine', 'Running OpenCode monthly SQL query...');
		const monthlyRows = await runDBQuery(binary, monthlySQL);
		monthlyCost = monthlyRows[0]?.monthly_cost ?? 0;
	}

	const fiveHourCost = primary.five_hour_cost;
	const weeklyCost = primary.weekly_cost;

	const fiveHourRemaining = percentRemaining(fiveHourCost, fiveHourLimit);
	const weeklyRemaining = percentRemaining(weeklyCost, weeklyLimit);
	const monthlyRemaining = percentRemaining(monthlyCost, monthlyLimit);

	// Five hour oldest reset calculation
	let fiveHourReset = new Date(nowMs + 5 * 3600 * 1000);
	if (primary.five_hour_oldest_ms !== null) {
		fiveHourReset = new Date(primary.five_hour_oldest_ms + 5 * 3600 * 1000);
	}

	const quotas: UsageQuota[] = [
		{
			percentRemaining: fiveHourRemaining,
			quotaType: '5h Limit',
			providerId: 'opencode-go',
			resetsAt: fiveHourReset.toISOString(),
			resetText: `$${fiveHourCost.toFixed(2)} / $${fiveHourLimit.toFixed(2)}`,
		},
		{
			percentRemaining: weeklyRemaining,
			quotaType: 'Weekly Limit',
			providerId: 'opencode-go',
			resetsAt: weekEnd.toISOString(),
			resetText: `$${weeklyCost.toFixed(2)} / $${weeklyLimit.toFixed(2)}`,
		},
		{
			percentRemaining: monthlyRemaining,
			quotaType: 'Monthly Limit',
			providerId: 'opencode-go',
			resetsAt: monthEnd.toISOString(),
			resetText: `$${monthlyCost.toFixed(2)} / $${monthlyLimit.toFixed(2)}`,
		},
	];

	return {
		providerId: 'opencode-go',
		quotas,
		capturedAt: now.toISOString(),
	};
}
