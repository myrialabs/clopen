/**
 * What every `@` mention source provides.
 *
 * A source lists what it can mention and takes the snapshot of what was
 * picked. Sources never touch the composer or the prompt: what they return is
 * a context document (shared/utils/context-document.ts), and from there it is
 * an attachment like any other.
 */

import type { WSConnection } from '$shared/utils/ws-server';
import type { IconName } from '$shared/types/ui/icons';
import type { CapturedAttachment, ContextKind, MentionCandidate, MentionRef } from '$shared/types/mentions';
import type { ContextDocument } from '$shared/utils/context-document';

export interface MentionContext {
	conn: WSConnection;
	projectId: string;
	/** The project's own directory. */
	projectPath: string;
	/** Root of the workspace on screen — the project, or one of its worktrees. */
	root: string;
	/** The chat the composer belongs to, when there is one. */
	chatSessionId: string | null;
}

/** A list the picker can open: "Terminals", "Commits", one database. */
export interface MentionCategory {
	id: string;
	label: string;
	/** Every row has one, so the list reads evenly. */
	detail: string;
	icon: IconName;
	group: string;
}

export interface ListRequest {
	/** The category asked for; absent at the picker's root. */
	category?: string;
	/** What was typed after `@`; may be empty. */
	query: string;
	limit: number;
}

/** A snapshot: one or more documents, and the pictures that go with them. */
export interface MentionCapture {
	documents: ContextDocument[];
	images?: CapturedAttachment[];
}

export interface MentionSource {
	/** Kinds this source captures. */
	kinds: ContextKind[];
	/** The lists it offers at the picker's root. */
	categories(ctx: MentionContext): MentionCategory[] | Promise<MentionCategory[]>;
	/**
	 * Rows for a request. At the root (no category) only cheap, local lookups
	 * belong here — every source answers each keystroke. A category this source
	 * does not own answers nothing.
	 */
	list(ctx: MentionContext, request: ListRequest): Promise<MentionCandidate[]>;
	capture(ctx: MentionContext, kind: ContextKind, ref: MentionRef): Promise<MentionCapture>;
}

/** A ref field as a string, or an error naming it. */
export function refString(ref: MentionRef, key: string): string {
	const value = ref[key];
	if (typeof value !== 'string' || !value) throw new Error(`Missing ${key}`);
	return value;
}

/** A ref field as a string when it is one. */
export function refOptional(ref: MentionRef, key: string): string | undefined {
	const value = ref[key];
	return typeof value === 'string' && value ? value : undefined;
}
