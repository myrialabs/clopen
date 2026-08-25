/**
 * Focus And Select Action
 * Svelte action that focuses an input on mount and selects its contents —
 * used for inline rename / search fields.
 */

export function focusAndSelect(node: HTMLInputElement) {
	node.focus();
	node.select();
}
