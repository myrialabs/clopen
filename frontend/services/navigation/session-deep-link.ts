/**
 * `#session/<projectId>/<chatSessionId>` — open one chat session from a link.
 *
 * The link a notification channel puts under "Open in Clopen". Clopen is a
 * single page whose current project and session are server-side state, so the
 * hash is read once the app is signed in, applied through the same calls the
 * command palette uses, and then dropped from the address bar — leaving it
 * there would yank the user back to that session on every reload.
 */

import ws from '$frontend/utils/ws';
import { projectState, setCurrentProject } from '$frontend/stores/core/projects.svelte';
import { setCurrentSession } from '$frontend/stores/core/sessions.svelte';
import { setCurrentView } from '$frontend/stores/core/app.svelte';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import { debug } from '$shared/utils/logger';

const SESSION_HASH = /^#session\/([^/]+)\/([^/]+)$/;

/** How long to wait for the project list on a cold start before giving up. */
const PROJECTS_TIMEOUT_MS = 10_000;

export function parseSessionHash(hash: string): { projectId: string; chatSessionId: string } | null {
	const match = SESSION_HASH.exec(hash);
	if (!match) return null;
	try {
		return { projectId: decodeURIComponent(match[1]), chatSessionId: decodeURIComponent(match[2]) };
	} catch {
		return null;
	}
}

async function waitForProjects(): Promise<void> {
	const started = Date.now();
	while ((projectState.isLoading || projectState.projects.length === 0) && Date.now() - started < PROJECTS_TIMEOUT_MS) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function openFromHash(): Promise<void> {
	const target = parseSessionHash(window.location.hash);
	if (!target) return;
	history.replaceState(null, '', window.location.pathname + window.location.search);

	try {
		await waitForProjects();
		const project = projectState.projects.find((entry) => entry.id === target.projectId);
		if (!project) {
			addNotification({ type: 'error', title: 'Session not available', message: 'That project is not one you can open.' });
			return;
		}
		if (project.id !== projectState.currentProject?.id) await setCurrentProject(project);
		const { session } = await ws.http('sessions:get', { id: target.chatSessionId });
		await setCurrentSession(session);
		setCurrentView('chat');
	} catch (error) {
		debug.warn('session', 'Opening a session from a link failed:', error);
		addNotification({ type: 'error', title: 'Session not available', message: 'That session no longer exists or you cannot open it.' });
	}
}

let initialized = false;

/** Apply a session link now, and whenever the hash changes to one. Call once signed in. */
export function initSessionDeepLink(): void {
	if (initialized) return;
	initialized = true;
	void openFromHash();
	window.addEventListener('hashchange', () => void openFromHash());
}
