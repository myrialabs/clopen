/**
 * Paging for lists a person picks from. A chat screen holds a dozen items and
 * a keyboard holds a few dozen buttons, so every list is cut into pages with
 * a "More…" choice that asks the same action for the next one.
 */

import type { ControlChoice } from './types';

export const PAGE_SIZE = 20;

export function paged<T>(
	items: T[],
	page: number | undefined,
	toChoice: (item: T) => ControlChoice,
	more: { action: string; args?: Record<string, unknown> },
	size = PAGE_SIZE
): { choices: ControlChoice[]; range: string } {
	const index = Math.max(0, page ?? 0);
	const slice = items.slice(index * size, (index + 1) * size);
	const choices = slice.map(toChoice);
	if ((index + 1) * size < items.length) {
		choices.push({ label: 'More…', action: more.action, args: { ...(more.args ?? {}), page: index + 1 } });
	}
	const range = items.length > size ? ` (${index * size + 1}–${index * size + slice.length} of ${items.length})` : '';
	return { choices, range };
}
