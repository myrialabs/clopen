/**
 * DB Client → environment variables.
 *
 * Its own store rather than part of `db-client.svelte.ts`, for the same reason
 * the accounts store is: that file is the panel's core and every screen reads
 * it, while this is one modal's lifecycle — empty until someone opens it, and
 * about a PROJECT as much as about a connection.
 *
 * Two things here are load-bearing rather than incidental.
 *
 * **Every preview is generation-guarded.** The prefix field previews as you
 * type, so two requests for the same connection are in flight routinely, and a
 * slower earlier one landing last would show a diff for text that is no longer
 * in the box.
 *
 * **Every action has its own busy flag.** Preview, apply and undo can each be
 * in progress, and a button that fires while it is already working is how a
 * user applies the same write twice.
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import type {
	DbEnvApplyResult,
	DbEnvPlan,
	DbEnvRole,
	DbEnvShape,
	DbEnvShapeInfo,
	DbEnvState
} from '$shared/types/db-client';

/** How long to wait after a keystroke before asking the server again. */
const PREVIEW_DEBOUNCE_MS = 300;

type KeyMap = Partial<Record<DbEnvRole, string>>;

interface EnvFormState {
	connectionId: string | null;
	database: string | null;
	loading: boolean;
	error: string | null;
	state: DbEnvState | null;

	shape: DbEnvShape;
	prefix: string;
	/**
	 * The project's own variable names, when the user is following them.
	 *
	 * Cleared the moment they type a prefix or switch shape: both mean "call it
	 * something else", and keeping the detected names would make the prefix box
	 * a control that changes nothing.
	 */
	keyMap: KeyMap | null;
	fileName: string;
	includeAlternate: boolean;

	plan: DbEnvPlan | null;
	previewing: boolean;
	previewError: string | null;

	applying: boolean;
	removing: boolean;
	result: DbEnvApplyResult | null;
}

const form = $state<EnvFormState>({
	connectionId: null,
	database: null,
	loading: false,
	error: null,
	state: null,
	shape: 'url',
	prefix: 'DATABASE',
	keyMap: null,
	fileName: '',
	includeAlternate: false,
	plan: null,
	previewing: false,
	previewError: null,
	applying: false,
	removing: false,
	result: null
});

let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewGeneration = 0;

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/** Exactly what the three env routes take — the route schema types the call. */
interface EnvRequestPayload {
	connectionId: string;
	database?: string;
	shape: DbEnvShape;
	prefix: string;
	keyMap?: Record<string, string>;
	fileName: string;
	includeAlternate: boolean;
	allowTracked?: boolean;
}

function requestPayload(extra: { allowTracked?: boolean } = {}): EnvRequestPayload {
	return {
		connectionId: form.connectionId ?? '',
		database: form.database ?? undefined,
		shape: form.shape,
		prefix: form.prefix,
		keyMap: (form.keyMap ?? undefined) as Record<string, string> | undefined,
		fileName: form.fileName,
		includeAlternate: form.includeAlternate,
		...extra
	};
}

async function runPreview(): Promise<void> {
	if (!form.connectionId) return;
	const generation = ++previewGeneration;
	form.previewing = true;

	try {
		const plan = (await ws.http('db-client:env-preview', requestPayload())) as DbEnvPlan;
		if (generation !== previewGeneration) return;
		form.plan = plan;
		form.previewError = null;
	} catch (error) {
		if (generation !== previewGeneration) return;
		form.plan = null;
		form.previewError = messageOf(error, 'Could not work out what applying would change.');
	} finally {
		if (generation === previewGeneration) form.previewing = false;
	}
}

function schedulePreview(): void {
	// The result on screen describes the PREVIOUS settings, so it goes as soon
	// as the settings change rather than when the new preview lands.
	form.result = null;
	if (previewTimer) clearTimeout(previewTimer);
	previewTimer = setTimeout(() => {
		previewTimer = null;
		void runPreview();
	}, PREVIEW_DEBOUNCE_MS);
}

export const dbEnvStore = {
	get connectionId(): string | null {
		return form.connectionId;
	},
	get loading(): boolean {
		return form.loading;
	},
	get error(): string | null {
		return form.error;
	},
	get state(): DbEnvState | null {
		return form.state;
	},
	get shape(): DbEnvShape {
		return form.shape;
	},
	get keyMap(): KeyMap | null {
		return form.keyMap;
	},
	get prefix(): string {
		return form.prefix;
	},
	get fileName(): string {
		return form.fileName;
	},
	get includeAlternate(): boolean {
		return form.includeAlternate;
	},
	get plan(): DbEnvPlan | null {
		return form.plan;
	},
	get previewing(): boolean {
		return form.previewing;
	},
	get previewError(): string | null {
		return form.previewError;
	},
	get applying(): boolean {
		return form.applying;
	},
	get removing(): boolean {
		return form.removing;
	},
	get busy(): boolean {
		return form.applying || form.removing;
	},
	get result(): DbEnvApplyResult | null {
		return form.result;
	},

	get shapeInfo(): DbEnvShapeInfo | null {
		return form.state?.shapes.find((entry) => entry.id === form.shape) ?? null;
	},

	/** Dotenv files a write may target. Templates are never offered. */
	get writableFiles(): string[] {
		return (form.state?.detection.files ?? [])
			.filter((file) => !file.isTemplate)
			.map((file) => file.name);
	},

	/**
	 * Load the panel for one connection and preview its suggested write.
	 *
	 * The suggestion is the point of the round trip: it carries the convention
	 * the project already uses and the file that convention lives in, so the
	 * form opens on the right answer instead of on a default.
	 */
	async open(connectionId: string, database?: string, projectId?: string): Promise<void> {
		form.connectionId = connectionId;
		form.database = database ?? null;
		form.loading = true;
		form.error = null;
		form.plan = null;
		form.previewError = null;
		form.result = null;

		try {
			const state = (await ws.http('db-client:env-state', {
				connectionId,
				projectId,
				database
			})) as DbEnvState;
			if (form.connectionId !== connectionId) return;

			form.state = state;
			form.shape = state.suggestion.shape;
			form.prefix = state.suggestion.prefix;
			form.keyMap = state.suggestion.keyMap;
			form.fileName = state.suggestion.fileName ?? '';
			// Off by default: the second endpoint costs a provider round trip, and
			// most projects want the one URL they asked for.
			form.includeAlternate = false;
			form.error = null;
			await runPreview();
		} catch (error) {
			if (form.connectionId !== connectionId) return;
			form.state = null;
			form.error = messageOf(error, 'Could not read this connection.');
			debug.warn('db-client', 'env state failed:', error);
		} finally {
			if (form.connectionId === connectionId) form.loading = false;
		}
	},

	close(): void {
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = null;
		previewGeneration += 1;
		form.connectionId = null;
		form.database = null;
		form.state = null;
		form.plan = null;
		form.error = null;
		form.previewError = null;
		form.result = null;
		form.previewing = false;
	},

	setShape(shape: DbEnvShape): void {
		if (form.shape === shape) return;
		form.shape = shape;
		// The detected names belong to the shape they were found in — a split
		// project's `DB_HOST` says nothing about what its URL should be called —
		// so switching shape falls back to the prefix.
		form.keyMap = null;
		schedulePreview();
	},

	setPrefix(prefix: string): void {
		form.prefix = prefix.toUpperCase();
		// Typing a prefix IS renaming, so the detected names stop applying;
		// otherwise the box would change nothing and read as broken.
		form.keyMap = null;
		schedulePreview();
	},

	/** Follow the names the project already uses. */
	useNames(input: { shape: DbEnvShape; prefix: string; keyMap: KeyMap }): void {
		form.shape = input.shape;
		form.prefix = input.prefix;
		form.keyMap = input.keyMap;
		schedulePreview();
	},

	setFileName(fileName: string): void {
		if (form.fileName === fileName) return;
		form.fileName = fileName;
		schedulePreview();
	},

	setIncludeAlternate(include: boolean): void {
		if (form.includeAlternate === include) return;
		form.includeAlternate = include;
		schedulePreview();
	},

	/** Ask again now, skipping the debounce — for a manual retry. */
	async refresh(): Promise<void> {
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = null;
		await runPreview();
	},

	/**
	 * Write it.
	 *
	 * `allowTracked` is a separate argument rather than a stored setting so it
	 * cannot survive a change of file: agreeing to commit a password into one
	 * tracked file is not agreement to do it to the next one.
	 */
	async apply(allowTracked = false): Promise<DbEnvApplyResult | null> {
		if (!form.connectionId || form.applying) return null;
		form.applying = true;
		form.result = null;

		try {
			const result = (await ws.http(
				'db-client:env-apply',
				requestPayload({ allowTracked })
			)) as DbEnvApplyResult;
			form.result = result;
			form.previewError = null;
			// The file has changed, so the diff on screen describes a state that no
			// longer exists.
			await runPreview();
			return result;
		} catch (error) {
			form.result = {
				status: 'failed',
				detail: messageOf(error, 'Could not write the environment file.'),
				fileName: form.fileName,
				updated: [],
				appended: []
			};
			return form.result;
		} finally {
			form.applying = false;
		}
	},

	/** Take it back out, restoring whatever value it replaced. */
	async remove(): Promise<DbEnvApplyResult | null> {
		if (!form.connectionId || form.removing) return null;
		form.removing = true;
		form.result = null;

		try {
			const result = (await ws.http('db-client:env-remove', requestPayload())) as DbEnvApplyResult;
			form.result = result;
			await runPreview();
			return result;
		} catch (error) {
			form.result = {
				status: 'failed',
				detail: messageOf(error, 'Could not undo the write.'),
				fileName: form.fileName,
				updated: [],
				appended: []
			};
			return form.result;
		} finally {
			form.removing = false;
		}
	}
};
