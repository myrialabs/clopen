/**
 * Claude fork deduplication.
 *
 * Clopen resumes Claude with `forkSession: true` on every turn (lessons-learned
 * §10.10: each turn needs its own immutable session id so a branch can be cut at
 * any message). The SDK implements a fork by copying the whole conversation into
 * a new file under the new id, KEEPING every entry's uuid. A chat of N turns
 * therefore leaves N files whose sizes add up to roughly N²/2 turns of content —
 * one measured chat held 265 files and 2.6 GB for a conversation whose newest
 * file is 25 MB.
 *
 * Because uuids survive the copy, an earlier fork F is entirely contained in a
 * later fork G of the same conversation, and "resume F" is the same state as
 * "resume G, cut at F's last entry" (`resumeSessionAt`). So F's file can go and
 * be remembered as that alias. Containment is checked on the actual entries,
 * never inferred from names, order or size: a file is deduplicated only when
 * every chain entry it holds is present in the target.
 */

import { readFileChunks, yieldToEventLoop } from '../fs-size';
import type { TranscriptEntry } from './types';

export interface ChainSummary {
	uuids: Set<string>;
	/** uuid of the last chain entry — what `resumeSessionAt` cuts at. */
	tip: string | null;
}

/**
 * The chain entries of a transcript: every line that carries a top-level `uuid`
 * and sits in the parent chain (`parentUuid` present, even as null). Metadata
 * lines (titles, cost state, queue operations) have neither and are skipped.
 */
export async function readChain(file: string): Promise<ChainSummary | null> {
	const uuids = new Set<string>();
	let tip: string | null = null;
	const decoder = new TextDecoder();
	let buffer = '';
	let lines = 0;

	const consume = (line: string) => {
		if (!line) return;
		// Cheap pre-filter before parsing: a chain line always names its parent.
		if (!line.includes('"parentUuid"')) return;
		try {
			const entry = JSON.parse(line) as { uuid?: unknown; parentUuid?: unknown; isSidechain?: unknown };
			if (typeof entry.uuid !== 'string' || !('parentUuid' in entry)) return;
			if (entry.isSidechain === true) return;
			uuids.add(entry.uuid);
			tip = entry.uuid;
		} catch { /* a torn last line from a crash — ignored */ }
	};

	try {
		for await (const chunk of readFileChunks(file)) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf('\n');
			while (newline !== -1) {
				consume(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf('\n');
				if (++lines % 500 === 0) await yieldToEventLoop();
			}
		}
		consume(buffer);
	} catch {
		return null;
	}
	return { uuids, tip };
}

export interface RedundantTranscript {
	entry: TranscriptEntry;
	target: TranscriptEntry;
	resumeAt: string;
}

function isSubset(small: Set<string>, large: Set<string>): boolean {
	if (small.size > large.size) return false;
	for (const value of small) if (!large.has(value)) return false;
	return true;
}

/**
 * Within one group of transcripts of the same conversation, which are fully
 * contained in another member. Survivors are the ones nothing contains; when two
 * files hold exactly the same entries, the newer one survives.
 */
export function findContained(
	group: { entry: TranscriptEntry; chain: ChainSummary }[]
): RedundantTranscript[] {
	// Largest first, so each file is matched against the biggest container and
	// chains of containment collapse onto one survivor.
	const ordered = [...group]
		.filter(member => member.chain.tip !== null && member.chain.uuids.size > 0)
		.sort((a, b) =>
			b.chain.uuids.size - a.chain.uuids.size ||
			b.entry.mtimeMs - a.entry.mtimeMs ||
			a.entry.id.localeCompare(b.entry.id)
		);

	const redundant: RedundantTranscript[] = [];
	const survivors: typeof ordered = [];
	for (const member of ordered) {
		const container = survivors.find(survivor => isSubset(member.chain.uuids, survivor.chain.uuids));
		if (container) {
			redundant.push({ entry: member.entry, target: container.entry, resumeAt: member.chain.tip! });
		} else {
			survivors.push(member);
		}
	}
	return redundant;
}

/**
 * Group transcripts by the chat that refers to them. Forks of one conversation
 * are referred to by the same chat (or by chats forked from it, which share
 * their earlier ids), so a group is a connected set over shared owners.
 */
export function groupByOwner(
	entries: TranscriptEntry[],
	owners: Map<string, Set<string>>
): TranscriptEntry[][] {
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root)!;
		parent.set(x, root);
		return root;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};

	const owned = entries.filter(entry => owners.has(entry.id));
	for (const entry of owned) {
		const chats = [...owners.get(entry.id)!];
		for (const chat of chats) if (!parent.has(chat)) parent.set(chat, chat);
		for (let i = 1; i < chats.length; i++) union(chats[0], chats[i]);
	}

	const groups = new Map<string, TranscriptEntry[]>();
	for (const entry of owned) {
		const key = `${entry.projectKey}\u0000${find([...owners.get(entry.id)!][0])}`;
		let list = groups.get(key);
		if (!list) groups.set(key, list = []);
		list.push(entry);
	}
	return [...groups.values()].filter(list => list.length > 1);
}
