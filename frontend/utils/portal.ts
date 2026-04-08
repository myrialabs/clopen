/**
 * Svelte action that teleports an element to document.body.
 * Useful for modals/dialogs inside `content-visibility: auto` containers,
 * which create a containing block that traps `position: fixed` elements.
 */
export function portal(node: HTMLElement) {
	document.body.appendChild(node);

	return {
		destroy() {
			node.remove();
		}
	};
}
