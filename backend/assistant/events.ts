/**
 * One event tells every open device that assistant state changed — tasks,
 * automations, the inbox, scripts, recordings or secrets. It carries no data: the views refetch
 * what they show, so a burst of changes costs one small message each.
 */

import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';

export type AssistantScope = 'tasks' | 'automations' | 'inbox' | 'scripts' | 'skills' | 'recordings' | 'settings' | 'secrets';

export function notifyAssistantChanged(scope: AssistantScope, id: string | null = null): void {
	try {
		ws.emit.global('assistant:changed', { scope, id });
	} catch (error) {
		debug.warn('assistant', 'Announcing an assistant change failed:', error);
	}
}
