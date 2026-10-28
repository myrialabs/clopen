/**
 * Shared facts about a user's workspace that more than one remote surface
 * needs: which model a new session should use, how a project is named, what
 * the latest session is. Kept here so the chat app's conversation and the
 * control actions answer these questions the same way.
 */

import type { EngineType } from '$shared/types/unified';
import type { ChatSession, Project } from '$shared/types/database/schema';
import { engineQueries, projectQueries, sessionQueries, settingsQueries } from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { ensureHomeProject } from '$backend/projects/home';
import { ws } from '$backend/utils/ws';
import { isHomeProject, HOME_PROJECT_NAME } from '$shared/utils/home-project';
import { debug } from '$shared/utils/logger';
import type { ControlTarget } from './types';

export interface ModelChoice {
	engine: EngineType;
	provider: string;
	modelId: string;
	modelName: string;
}

export function modelOf(session: ChatSession | null | undefined): ModelChoice | null {
	if (!session?.engine || !session.model_id) return null;
	return { engine: session.engine, provider: session.provider ?? '', modelId: session.model_id, modelName: session.model_name ?? session.model_id };
}

/** The model last picked in Clopen — the saved settings blob, read here only for this. */
export function settingsModel(userId: string): ModelChoice | null {
	try {
		const raw = settingsQueries.get(`user:${userId}:settings`)?.value;
		const settings = raw ? JSON.parse(raw) : null;
		if (settings?.selectedEngine && settings?.selectedModelId) {
			return {
				engine: settings.selectedEngine,
				provider: settings.selectedProvider ?? '',
				modelId: settings.selectedModelId,
				modelName: settings.selectedModelName ?? settings.selectedModelId
			};
		}
	} catch {
		// Unreadable settings: fall through to the user's sessions.
	}
	return null;
}

function byRecency(a: ChatSession, b: ChatSession): number {
	return (b.last_message_at ?? b.started_at).localeCompare(a.last_message_at ?? a.started_at);
}

export function recentSessions(projectId?: string): ChatSession[] {
	const projects = projectId ? [projectId] : projectQueries.getListed().map((project) => project.id);
	return projects.flatMap((id) => sessionQueries.getByProjectId(id)).sort(byRecency);
}

/** A model for a NEW session: this project's latest, the user's picked one, then any they used. */
export function pickModel(userId: string, projectId: string): ModelChoice | null {
	const inProject = recentSessions(projectId).map(modelOf).find(Boolean);
	return inProject ?? settingsModel(userId) ?? recentSessions().map(modelOf).find(Boolean) ?? null;
}

/**
 * The engine account a turn signs in with — what the web picker would send.
 * The session's own account when it pinned one of THIS engine's; otherwise
 * the active account of the model's provider, else of the engine. Null when
 * the engine has none (the stream then says so, and why).
 */
export function accountFor(session: ChatSession, model: ModelChoice): { id: number; name: string } | null {
	if (session.account_id) {
		const pinned = engineQueries.getAccount(session.account_id);
		const provider = pinned ? engineQueries.getProvider(pinned.provider_id) : null;
		if (pinned && provider?.engine_type === model.engine) return { id: pinned.id, name: pinned.name };
	}
	const provider = model.provider ? engineQueries.getProviderBySlug(model.engine, model.provider) : null;
	const active = (provider ? engineQueries.getActiveAccount(provider.id) : null) ?? engineQueries.getActiveAccountForEngine(model.engine);
	return active ? { id: active.id, name: active.name } : null;
}

export function latestSession(projectId: string): ChatSession | null {
	return sessionQueries.getByProjectId(projectId).sort(byRecency)[0] ?? null;
}

export function projectLabel(project: Project): string {
	return isHomeProject(project) ? HOME_PROJECT_NAME : project.name;
}

export function isSessionBusy(session: ChatSession): boolean {
	return streamManager.getSessionStream(session.id, session.project_id)?.status === 'active';
}

/** A new, empty session in `project`, using `model`, announced to any open tab. */
export function createSession(project: Project, model: ModelChoice): ChatSession {
	const session = sessionQueries.create({
		project_id: project.id,
		engine: model.engine,
		started_at: new Date().toISOString()
	});
	sessionQueries.updateEngineModel(session.id, model.engine, model.provider, model.modelId, model.modelName);
	const created = sessionQueries.getById(session.id) ?? session;
	try {
		ws.emit.project(project.id, 'sessions:session-available', { session: created });
	} catch (error) {
		debug.warn('control', 'Announcing a new session failed:', error);
	}
	return created;
}

/**
 * Resolve a target to rows that can be acted on. A project that was removed
 * falls back to Home; a session outside the project is dropped.
 */
export function resolveTarget(target: Partial<ControlTarget> | null): { project: Project; session: ChatSession | null } {
	let project = target?.projectId ? projectQueries.getById(target.projectId) : null;
	if (!project || !projectQueries.isListed(project.id)) project = ensureHomeProject();
	const session = target?.sessionId ? sessionQueries.getById(target.sessionId) : null;
	return { project, session: session && session.project_id === project.id ? session : null };
}

/** A session that can be acted on, with its project. */
export function accessibleSession(sessionId: string | null | undefined): { project: Project; session: ChatSession } | null {
	const session = sessionId ? sessionQueries.getById(sessionId) : null;
	const project = session ? projectQueries.getById(session.project_id) : null;
	if (!session || !project || !projectQueries.isListed(project.id)) return null;
	return { project, session };
}
