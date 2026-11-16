/**
 * Watch triggers — "tell me when this changes".
 *
 * A URL is fetched and fingerprinted by status and body; a file by size,
 * modification time and content. The first look records a baseline and runs
 * nothing: a watch reports changes, and the first observation is not one.
 * After that, a different fingerprint runs the job, with a short description
 * of what changed passed along as context.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';
import { homedir } from 'os';
import type { WatchTarget } from '$shared/types/assistant';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_HASHED_FILE = 5 * 1024 * 1024;
/** How much of the new content travels with the run, as context. */
const EXCERPT = 3000;

export interface Observation {
	fingerprint: string;
	summary: string;
	excerpt: string;
}

function hash(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** Visible text of an HTML page, so a changed nonce or timestamp in markup reads as what it is. */
function visibleText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export async function observe(target: WatchTarget): Promise<Observation> {
	if (target.kind === 'url') {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(target.url, { signal: controller.signal, redirect: 'follow' });
			const body = await response.text();
			const isHtml = (response.headers.get('content-type') ?? '').includes('html');
			const text = isHtml ? visibleText(body) : body;
			return {
				fingerprint: `${response.status}:${hash(text)}`,
				summary: `${target.url} answered ${response.status}`,
				excerpt: text.slice(0, EXCERPT)
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { fingerprint: `error:${hash(message)}`, summary: `${target.url} could not be reached: ${message}`, excerpt: '' };
		} finally {
			clearTimeout(timer);
		}
	}
	const path = resolve(target.path.replace(/^~(?=\/|$)/, homedir()));
	if (!existsSync(path)) return { fingerprint: 'missing', summary: `${path} does not exist`, excerpt: '' };
	const stat = statSync(path);
	if (stat.isDirectory()) return { fingerprint: `dir:${stat.mtimeMs}`, summary: `${path} (folder) changed`, excerpt: '' };
	if (stat.size > MAX_HASHED_FILE) return { fingerprint: `${stat.size}:${stat.mtimeMs}`, summary: `${path} changed (${stat.size} bytes)`, excerpt: '' };
	const content = readFileSync(path);
	return { fingerprint: `${stat.size}:${hash(content)}`, summary: `${path} changed (${stat.size} bytes)`, excerpt: content.toString('utf8').slice(0, EXCERPT) };
}

/** Compare against the stored state. Returns the context for a run when it changed, null otherwise. */
export function changeContext(previous: string | null, current: Observation): string | null {
	if (previous === null) return null;
	let before: { fingerprint?: string } = {};
	try {
		before = JSON.parse(previous);
	} catch {
		return null;
	}
	if (before.fingerprint === current.fingerprint) return null;
	return `${current.summary}.${current.excerpt ? `\nCurrent content (excerpt):\n${current.excerpt}` : ''}`;
}
