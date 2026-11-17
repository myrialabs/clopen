/**
 * Placing one streamed delta into the text received so far.
 *
 * `chat:partial` updates carry only the new piece and the length of the block
 * before it (`offset`). A client can join mid-block, see a frame twice, or miss
 * one, so the answer is one of three: nothing new, the text extended, or a gap
 * the client cannot fill on its own.
 */

export type DeltaPlacement =
	| { kind: 'unchanged' }
	| { kind: 'extended'; text: string }
	| { kind: 'gap' };

export function placeDelta(current: string, offset: number, delta: string): DeltaPlacement {
	const have = current.length;
	if (have >= offset + delta.length) return { kind: 'unchanged' };
	if (have < offset) return { kind: 'gap' };
	return { kind: 'extended', text: current + delta.slice(have - offset) };
}
