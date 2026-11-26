/**
 * The git hosting sign-in dialog, openable from anywhere.
 *
 * The Git panel's Publish card, its "push was refused" offer, the hosting
 * view's empty state and Settings all need the same dialog, and none of them
 * should send the user somewhere else first. So it is mounted once beside the
 * Settings modal and opened through here.
 */

import type { GitHostKind } from '$shared/types/git-hosting';

interface HostConnectState {
	isOpen: boolean;
	/** Preselected service. Null shows the service picker first. */
	provider: GitHostKind | null;
	/** Preselected server, for a remote on a self-hosted host. */
	baseUrl: string;
	/** Reconnect this account instead of adding one. */
	accountId: string | null;
	/** Bumped on every open, so the dialog re-seeds even for the same arguments. */
	openCount: number;
}

export const hostConnectState = $state<HostConnectState>({
	isOpen: false,
	provider: null,
	baseUrl: '',
	accountId: null,
	openCount: 0
});

/** Not reactive: a callback is not state, and a proxy around a closure buys nothing. */
let connectedListener: ((accountId: string) => void) | null = null;

export function openHostConnect(options: {
	provider?: GitHostKind | null;
	baseUrl?: string;
	accountId?: string | null;
	onConnected?: (accountId: string) => void;
} = {}): void {
	hostConnectState.provider = options.provider ?? null;
	hostConnectState.baseUrl = options.baseUrl ?? '';
	hostConnectState.accountId = options.accountId ?? null;
	hostConnectState.openCount += 1;
	hostConnectState.isOpen = true;
	connectedListener = options.onConnected ?? null;
}

export function closeHostConnect(): void {
	hostConnectState.isOpen = false;
	connectedListener = null;
}

/** Called by the dialog once an account is connected. */
export function notifyHostConnected(accountId: string): void {
	const listener = connectedListener;
	connectedListener = null;
	listener?.(accountId);
}
