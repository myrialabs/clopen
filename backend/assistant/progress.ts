/**
 * "How is it going?" — a task's progress in a few lines, with a look at the
 * screen when an agent is working in the browser.
 *
 * Read by the `task.progress` action and the Telegram `/tasks` command. The
 * screenshot is the latest frame of the Preview Browser tab an agent of the
 * task is driving right now, so the owner sees what is happening instead of
 * reading about it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { missionQueries } from '$backend/database/queries';
import { browserMcpControl } from '$backend/preview/browser/browser-mcp-control';
import { browserPreviewServiceManager } from '$backend/preview/browser/browser-preview-service';
import { getClopenDir } from '$backend/utils/paths';
import type { ControlFile } from '$backend/control/types';
import type { Mission } from '$shared/types/assistant';
import { debug } from '$shared/utils/logger';
import { toMission, toMissionEvent } from './mappers';

const KEPT_EVENTS = 4;

/** One line for a task: status, criteria, who is working on what. */
export function taskLine(mission: Mission): string {
	const done = mission.criteria.filter((item) => item.done).length;
	const criteria = mission.criteria.length ? ` · ${done}/${mission.criteria.length} done` : '';
	const working = mission.sessions.filter((session) => session.busy);
	const who = working.length
		? ` · ${working.map((session) => session.role ?? 'agent').join(', ')} working`
		: '';
	return `${mission.title} — ${mission.status}${criteria}${who}`;
}

/** The latest frame of a browser tab one of the task's chats is driving. */
async function screenshotFor(mission: Mission): Promise<ControlFile | null> {
	const sessions = [
		...mission.sessions.filter((session) => session.busy),
		...(mission.assistantSessionId ? [{ sessionId: mission.assistantSessionId, projectId: null as string | null }] : [])
	];
	for (const session of sessions) {
		const tabIds = browserMcpControl.getSessionTabs(session.sessionId);
		if (!tabIds.length || !session.projectId) continue;
		try {
			const tab = browserPreviewServiceManager.getService(session.projectId).getTab(tabIds[tabIds.length - 1]);
			if (!tab || tab.page.isClosed()) continue;
			const buffer = await tab.page.screenshot({ type: 'jpeg', quality: 70 });
			const dir = join(getClopenDir(), 'tmp', 'progress');
			await mkdir(dir, { recursive: true });
			const filename = `task-${mission.id.slice(0, 8)}-${Date.now()}.jpg`;
			const path = join(dir, filename);
			await writeFile(path, buffer);
			return { path, filename, mime: 'image/jpeg' };
		} catch (error) {
			debug.warn('assistant', 'Capturing a task screenshot failed:', error);
		}
	}
	return null;
}

export async function taskProgress(missionId: string): Promise<{ text: string; files: ControlFile[]; mission: Mission }> {
	const row = missionQueries.getById(missionId);
	if (!row) throw new Error(`There is no task ${missionId}.`);
	const mission = toMission(row);
	const events = missionQueries
		.eventsOf(mission.id, 40)
		.map(toMissionEvent)
		.filter((event) => event.kind !== 'prompt')
		.slice(-KEPT_EVENTS);
	const lines = [taskLine(mission)];
	for (const event of events) lines.push(`· ${event.createdAt.slice(11, 16)} ${event.text.replace(/\s+/g, ' ').slice(0, 160)}`);
	const shot = await screenshotFor(mission);
	return { text: lines.join('\n'), files: shot ? [shot] : [], mission };
}

/** Every open task in one message, with at most one screenshot. */
export async function openTasksProgress(): Promise<{ text: string; files: ControlFile[] }> {
	const open = missionQueries.listOpen().map(toMission);
	if (!open.length) return { text: 'No tasks running.', files: [] };
	const files: ControlFile[] = [];
	for (const mission of open) {
		if (files.length) break;
		if (!mission.sessions.some((session) => session.busy)) continue;
		const shot = await screenshotFor(mission);
		if (shot) files.push(shot);
	}
	return { text: open.slice(0, 10).map(taskLine).join('\n'), files };
}
