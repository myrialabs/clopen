/**
 * Cursor dynamic model discovery.
 *
 * `Cursor.models.list({ apiKey })` returns the models available to the
 * authenticated key (e.g. `composer-2.5`). We translate each into an
 * `EngineModel`. Returns `[]` on any failure (no account, bad key, network) —
 * the shared dynamic-catalog contract (the picker renders empty rather than a
 * stale list; mirrors OpenCode/Qwen/Cline).
 *
 * Per-model parameter variants (e.g. a `fast` toggle) are not surfaced yet — the
 * base model id is exposed and the SDK resolves the default variant.
 *
 * `Cursor.models.list()` is a cloud endpoint that 403s with `plan_required` for
 * free-tier keys. Rather than strand those users with an empty picker, we fall
 * back to a small static catalog of known Cursor models when the listing is
 * unavailable (empty or errored). Only a missing account/key returns `[]`.
 */

import { Cursor } from '@cursor/sdk';
import type { EngineModel } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { getActiveCursorAccount, parseCursorCredential } from './credential';

/** Known Cursor model ids used when `Cursor.models.list()` is unavailable. */
const CURSOR_FALLBACK_MODEL_IDS = ['composer-2.5'];

export async function fetchCursorModels(): Promise<EngineModel[]> {
	const account = getActiveCursorAccount();
	if (!account) return [];
	const apiKey = parseCursorCredential(account.credential)?.apiKey;
	if (!apiKey) return [];

	try {
		const models = await Cursor.models.list({ apiKey });
		if (models.length) {
			debug.log('engine', `Cursor getAvailableModels: ${models.length} models`);
			return models.map(m => makeModel(m.id, m.displayName || m.id));
		}
		debug.warn('engine', 'Cursor models.list returned empty — using fallback catalog');
	} catch (error) {
		debug.warn('engine', `Cursor model discovery failed (${error instanceof Error ? error.message : String(error)}) — using fallback catalog`);
	}
	return CURSOR_FALLBACK_MODEL_IDS.map(id => makeModel(id, id));
}

function makeModel(id: string, name: string): EngineModel {
	return {
		engine: {
			type: 'cursor',
			provider: 'cursor',
			model: { id, name },
			account: { id: 0, name: '' },
		},
		// Cursor's models.list() does NOT report a context window; leave 0 so the
		// UI shows "unknown" (a "?") rather than a fabricated/hardcoded max.
		limit: { input: 0, output: 0 },
		modalities: {
			input: { text: true, image: true, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
		},
		capabilities: {
			reasoning: true,
			tools: true,
			structuredOutput: false,
		},
		cost: { input: 0, output: 0 },
	};
}
