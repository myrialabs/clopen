/**
 * Asking the assistant something outside any mission — a check-in from a job,
 * a pattern the learning loop noticed, the outcome of an approval. Each goes to
 * a fresh assistant session titled for what it is, so the owner can open it
 * and see exactly what the assistant did about it.
 */

import { sessionQueries } from '$backend/database/queries';
import { ensureAssistantProject } from './project';
import { pickAssistantModel } from './model';
import { sendPromptAsOwner } from './prompt';

export async function askAssistant(
	text: string,
	options: { title: string; sessionId?: string | null; origin?: 'owner' | 'task' | 'flow' | 'system' }
): Promise<{ sessionId: string }> {
	const project = ensureAssistantProject();
	let session = options.sessionId ? sessionQueries.getById(options.sessionId) : null;
	if (session && session.project_id !== project.id) session = null;
	const model = session ? null : await pickAssistantModel();
	const sent = await sendPromptAsOwner({ project, session, text, model, title: options.title, origin: options.origin ?? 'system' });
	return { sessionId: sent.session.id };
}
