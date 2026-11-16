/**
 * The Clopen assistant (v0.5).
 *
 *   project.ts     the assistant's own workspace (a project row, kind `home`)
 *   brief.ts       what the assistant is told every turn
 *   missions.ts    tasks: goals driven across project sessions by specialists
 *   conversation.ts one conversation, many sessions: topic routing + capsules
 *   journal.ts     what happened, in order — the memory across chats
 *   profile.ts     who the owner is, kept by Clopen
 *   progress.ts    a task's progress with a screenshot of the agent's browser
 *   crew.ts        delegating a task to a crew that runs a recipe
 *   cards.ts       asking the owner where they are (questions, approvals, keys)
 *   connect.ts     connecting services from the chat
 *   notify.ts      telling the owner, with files
 *   share.ts       public links instead of local paths
 *   think.ts       one structured question to a model (judge, classify, plan)
 *   manager-policy.ts  Clopen's chat cannot build things itself
 *   intent-fallback.ts ```clopen blocks for models that cannot call tools
 *   inbox.ts       the one place the owner is asked for anything
 *   learning.ts    repeated commands → scripts, repeated requests → skills
 *   scripts.ts     deterministic automations
 *   skills.ts      skills the assistant writes and improves, with revisions
 *   recordings.ts  teach a task in the Preview Browser
 *   autostart.ts   start Clopen with the computer, so automations keep their schedule
 *   model.ts       which model the assistant runs on (free by default)
 *
 * Recipes run in `backend/recipes/`; flows live in `backend/jobs/` (stored as
 * jobs); the control surface
 * agents drive in `backend/control/agent/`, exposed as the `run` tool of the
 * `control` internal MCP server.
 */

import { inboxQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';
import { initMissions } from './missions';
import { initLearning } from './learning';
import { initJournal } from './journal';
import { initIntentFallback } from './intent-fallback';
import { initModelFallback } from './fallback';
import { initJobRunner } from '$backend/jobs/runner';
import { startJobScheduler, stopJobScheduler } from '$backend/jobs/scheduler';
import { ensureAssistantProject } from './project';
import { initAck } from './ack';
import { initTimeline } from './timeline';

let started = false;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

/** Wire the assistant to the stream and start the job scheduler. Once, after the database is up. */
export function startAssistant(): void {
	if (started) return;
	started = true;
	try {
		ensureAssistantProject();
	} catch (error) {
		debug.warn('assistant', 'Preparing the assistant workspace failed:', error);
	}
	initMissions();
	initLearning();
	initJournal();
	initIntentFallback();
	initModelFallback();
	initAck();
	initTimeline();
	initJobRunner();
	startJobScheduler();
	// The free model every job defaults to, found once early so memory's readiness can see it.
	setTimeout(() => void import('./model').then(({ freeAssistantModel }) => freeAssistantModel()).catch(() => null), 8000);
	// A crew does not survive a restart in memory; pick each one up again (its chats keep their context).
	setTimeout(() => void import('./crew').then(({ resumeCrews }) => resumeCrews()).catch((error) => debug.warn('assistant', 'Resuming crews failed:', error)), 5000);
	// Once per install: passwords that reached the history before secrets were typed by name leave it.
	setTimeout(() => void import('./scrub').then(({ scrubKnownSecretsOnce }) => scrubKnownSecretsOnce()).catch((error) => debug.warn('assistant', 'Scrubbing secrets from history failed:', error)), 60_000);
	inboxQueries.prune();
	pruneTimer = setInterval(() => inboxQueries.prune(), 6 * 60 * 60 * 1000);
	debug.log('assistant', 'Clopen assistant started');
}

export function stopAssistant(): void {
	stopJobScheduler();
	if (pruneTimer) clearInterval(pruneTimer);
	pruneTimer = null;
}
