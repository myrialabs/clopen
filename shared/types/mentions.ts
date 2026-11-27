/**
 * `@` mentions — everything a message can point at besides its own files.
 *
 * A mention becomes a numbered attachment of the message, like a dropped file:
 * the same `@N`, the same card, the same renumbering. What the attachment holds
 * is a snapshot taken at the moment it was mentioned — a terminal's output, a
 * diff, a page element — written as a document whose first line says what it
 * is (see `shared/utils/context-document.ts`). Every snapshot is saved into the
 * session's folder and the engine is given its path, so a big one costs the
 * model a read, not its context window.
 */

import type { IconName } from './ui/icons';

/** What a mention is of. */
export type ContextKind =
	| 'file'
	| 'folder'
	| 'code'
	| 'terminal'
	| 'terminal-selection'
	| 'git-changes'
	| 'git-staged'
	| 'git-file'
	| 'git-commit'
	| 'git-branch'
	| 'git-stash'
	| 'git-conflicts'
	| 'preview-tab'
	| 'preview-element'
	| 'preview-console'
	| 'chat-session'
	| 'chat-message'
	| 'project'
	| 'ai-changes'
	| 'work-item'
	| 'note'
	| 'memory'
	| 'db-connection'
	| 'db-table'
	| 'db-result'
	| 'deployment'
	| 'container'
	| 'port'
	| 'env-file';

/**
 * What a context attachment is, read from its own first line. Carried on the
 * saved message too (`FileBlock.source`), so the timeline can draw the card
 * without reading the file.
 */
export interface ContextSource {
	kind: ContextKind;
	/** Short name: a tab title, a file path, a commit subject. */
	label: string;
	/** One line of extra detail: "1,240 lines", "src/app.ts · L10–24". */
	detail?: string;
	/**
	 * For a `file` mention, the file itself, relative to the workspace root:
	 * the engine is pointed at the real file rather than at a copy of it.
	 */
	path?: string;
	/** ISO time the snapshot was taken. */
	capturedAt: string;
}

/** Where a mentionable thing is looked up when it is picked. */
export type MentionRef = Record<string, string | number | boolean | null>;

/** One row of the `@` picker. */
export interface MentionCandidate {
	/** Unique within one result list. */
	key: string;
	kind: ContextKind;
	/** Heading the row is listed under. */
	group: string;
	label: string;
	/** Every row has one, so the list reads evenly. */
	detail: string;
	icon: IconName;
	/** Handed back to `mentions:capture` when the row is picked. */
	ref: MentionRef;
	/**
	 * Set on a row that opens a list rather than being picked — a category, a
	 * database to look into. The value is the category asked for next.
	 */
	browse?: string;
}

/** A file a capture produced: a context document, or an image beside it. */
export interface CapturedAttachment {
	fileName: string;
	mediaType: string;
	/** Base64 bytes. */
	data: string;
}
