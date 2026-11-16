/**
 * How the Clopen assistant works — read from the system settings, with the
 * agreed defaults: fully autonomous, irreversible actions still go through the
 * Inbox.
 */

import { readSystemSetting, writeSystemSettings } from '$backend/settings/system-settings';
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '$shared/types/assistant';

export function getAssistantSettings(): AssistantSettings {
	const stored = readSystemSetting((settings) => settings.assistant, undefined);
	return {
		autonomy: stored?.autonomy === 'ask' ? 'ask' : DEFAULT_ASSISTANT_SETTINGS.autonomy,
		allowIrreversible: stored?.allowIrreversible === true
	};
}

export function saveAssistantSettings(patch: Partial<AssistantSettings>): AssistantSettings {
	const next = { ...getAssistantSettings(), ...patch };
	writeSystemSettings({ assistant: next });
	return next;
}
