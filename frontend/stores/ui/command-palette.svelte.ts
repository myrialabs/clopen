/**
 * Command Palette Store
 * Global Spotlight-style palette (Projects, Actions, Settings, Sessions).
 * Only tracks open/closed state — query and selection are transient UI state
 * owned by CommandPalette.svelte and reset every time it opens.
 */

interface CommandPaletteState {
	isOpen: boolean;
}

export const commandPaletteState = $state<CommandPaletteState>({
	isOpen: false
});

export function openCommandPalette() {
	commandPaletteState.isOpen = true;
}

export function closeCommandPalette() {
	commandPaletteState.isOpen = false;
}

export function toggleCommandPalette() {
	commandPaletteState.isOpen = !commandPaletteState.isOpen;
}
