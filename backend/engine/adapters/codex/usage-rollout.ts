/**
 * Codex rollout-file usage extraction (workaround).
 *
 * The Codex CLI's `--experimental-json` `turn.completed.usage` is the SUM of
 * `input_tokens` across every internal API call within a turn — useful for
 * cost accounting but wrong for context-window display. A turn that makes 5
 * tool-calling round-trips reports 5× the actual prompt size, so the UI's
 * "% of context" indicator overcounts dramatically (we saw ~117k displayed
 * when the real per-call load was ~20k).
 *
 * The CLI also writes a richer `event_msg` / `token_count` payload to the
 * rollout JSONL at `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`,
 * which contains both `total_token_usage` (cumulative — what the SDK forwards)
 * AND `last_token_usage` (the real per-call load). We read the rollout's last
 * `token_count` event after each turn and use `last_token_usage` instead.
 *
 * TODO(codex-sdk): delete this entire helper once `@openai/codex-sdk` exposes
 * per-call usage natively (e.g. `turn.completed.lastUsage` or a dedicated
 * `token_count` event in the SDK's typed `ThreadEvent` union). When that
 * lands:
 *   1. Switch `convertTurnCompleted` in ./message-converter.ts back to
 *      reading the SDK's per-call field directly — no filesystem access.
 *   2. Remove the `import { readLastTokenUsageFromRollout } from './usage-rollout'`
 *      line from message-converter.ts.
 *   3. Delete this file.
 *
 * Until then, this helper is a private contract with an undocumented internal
 * file format. Codex CLI may rename fields, change the directory layout, or
 * stop writing rollout files between releases — keep the fallback to
 * `event.usage` in `convertTurnCompleted` so the adapter degrades gracefully.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Usage } from '@openai/codex-sdk';
import { getCodexHomeDir } from './credential';
import { debug } from '$shared/utils/logger';

const SESSIONS_DIR_NAME = 'sessions';

/**
 * Locate the rollout file for `threadId`.
 *
 * Layout: `<codex-home>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-mm-ss-<thread_id>.jsonl`.
 * We can't predict the timestamp prefix, so we walk year/month/day directories
 * looking for a filename ending in `<thread_id>.jsonl`. Returns the freshest
 * match by mtime (forks/restarts can create multiple).
 */
export function findRolloutFile(threadId: string): string | null {
	if (!threadId) return null;
	const sessionsRoot = path.join(getCodexHomeDir(), SESSIONS_DIR_NAME);
	const suffix = `${threadId}.jsonl`;
	let best: { file: string; mtimeMs: number } | null = null;

	let years: string[] = [];
	try {
		years = fs.readdirSync(sessionsRoot);
	} catch {
		return null;
	}

	for (const year of years) {
		const yearDir = path.join(sessionsRoot, year);
		let months: string[] = [];
		try { months = fs.readdirSync(yearDir); } catch { continue; }
		for (const month of months) {
			const monthDir = path.join(yearDir, month);
			let days: string[] = [];
			try { days = fs.readdirSync(monthDir); } catch { continue; }
			for (const day of days) {
				const dayDir = path.join(monthDir, day);
				let entries: string[] = [];
				try { entries = fs.readdirSync(dayDir); } catch { continue; }
				for (const entry of entries) {
					if (!entry.endsWith(suffix)) continue;
					const full = path.join(dayDir, entry);
					try {
						const stat = fs.statSync(full);
						if (!best || stat.mtimeMs > best.mtimeMs) {
							best = { file: full, mtimeMs: stat.mtimeMs };
						}
					} catch { /* ignore */ }
				}
			}
		}
	}

	return best?.file ?? null;
}

interface RolloutTokenInfo {
	last_token_usage?: {
		input_tokens?: number;
		cached_input_tokens?: number;
		output_tokens?: number;
		reasoning_output_tokens?: number;
	};
	model_context_window?: number;
}

/**
 * Read the rollout file and return the most recent `token_count` event's
 * `last_token_usage`. Returns null if the file or event is missing.
 *
 * Scans from the end of the file (one chunk at a time) so we don't load the
 * full transcript into memory just to find the last entry.
 */
export function readLastTokenUsageFromRollout(threadId: string): Usage | null {
	const file = findRolloutFile(threadId);
	if (!file) return null;

	let info: RolloutTokenInfo | null = null;
	try {
		// Rollout files are JSONL with one event per line. Reading the whole
		// file and walking lines in reverse is the simplest reliable way to
		// find the last `token_count` event — these files are typically
		// well under a few MB.
		const content = fs.readFileSync(file, 'utf-8');
		const lines = content.split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line || !line.includes('"token_count"')) continue;
			try {
				const parsed = JSON.parse(line);
				const payload = parsed?.payload;
				if (payload?.type === 'token_count' && payload.info) {
					info = payload.info as RolloutTokenInfo;
					break;
				}
			} catch { /* malformed line — keep scanning */ }
		}
	} catch (err) {
		debug.warn('engine', `Codex usage-rollout: failed to read ${file}:`, err);
		return null;
	}

	const last = info?.last_token_usage;
	if (!last) return null;

	return {
		input_tokens: last.input_tokens ?? 0,
		cached_input_tokens: last.cached_input_tokens ?? 0,
		output_tokens: last.output_tokens ?? 0,
		reasoning_output_tokens: last.reasoning_output_tokens ?? 0,
	};
}
