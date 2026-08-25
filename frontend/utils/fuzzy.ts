/**
 * Lightweight fuzzy subsequence matching for the Command Palette.
 *
 * Pure, local, and synchronous — no engine round-trip — so Quick Search stays
 * instant. Scoring rewards exact/prefix hits, consecutive runs, and matches at
 * word boundaries so the most relevant result floats to the top as you type.
 */

/** Characters that mark the start of a "word" for boundary bonuses. */
const WORD_BOUNDARY = /[\s\-_/.:@]/;

export interface FuzzyMatch {
	/** Higher is a better match. */
	score: number;
	/** Indices in the target string that matched, for optional highlighting. */
	positions: number[];
}

/**
 * Match `query` as a subsequence of `text` (case-insensitive). Returns `null`
 * when not every query character can be found in order. An empty query matches
 * anything with a neutral score of 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
	const q = query.trim().toLowerCase();
	if (!q) return { score: 0, positions: [] };
	const t = text.toLowerCase();

	// Exact-substring is the strongest signal — take it directly.
	const exactIdx = t.indexOf(q);
	if (exactIdx !== -1) {
		const boundaryBonus = exactIdx === 0 || WORD_BOUNDARY.test(t[exactIdx - 1]) ? 20 : 0;
		const positions = Array.from({ length: q.length }, (_, i) => exactIdx + i);
		return { score: 100 + boundaryBonus - exactIdx * 0.1, positions };
	}

	const positions: number[] = [];
	let score = 0;
	let ti = 0;
	let prevMatch = -2;
	for (let qi = 0; qi < q.length; qi++) {
		const ch = q[qi];
		let found = -1;
		for (; ti < t.length; ti++) {
			if (t[ti] === ch) {
				found = ti;
				break;
			}
		}
		if (found === -1) return null; // query char missing → not a subsequence
		let charScore = 1;
		if (found === prevMatch + 1) charScore += 3; // consecutive run
		if (found === 0 || WORD_BOUNDARY.test(t[found - 1])) charScore += 5; // word start
		score += charScore;
		positions.push(found);
		prevMatch = found;
		ti = found + 1;
	}
	// Slightly prefer denser matches (query fills more of the target).
	score += Math.max(0, 10 - (t.length - q.length) * 0.05);
	return { score, positions };
}

/**
 * Best fuzzy score across several candidate strings (e.g. label, description,
 * keywords). Returns 0 when none of them match, so callers can treat `> 0` as
 * "matched".
 */
export function bestFuzzyScore(query: string, texts: (string | undefined | null)[]): number {
	if (!query.trim()) return 0;
	let best = 0;
	for (const text of texts) {
		if (!text) continue;
		const m = fuzzyMatch(query, text);
		if (m && m.score > best) best = m.score;
	}
	return best;
}
