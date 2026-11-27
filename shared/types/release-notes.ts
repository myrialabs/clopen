/**
 * A GitHub release, read for the people who use Clopen rather than the people
 * who build it: conventional-commit prefixes become a kind, author handles and
 * pull-request URLs become a number. See backend/update/release-notes.ts.
 */

export type ReleaseChangeKind = 'feature' | 'improvement' | 'fix' | 'other';

export interface ReleaseChange {
	kind: ReleaseChangeKind;
	/** The commit scope — `chat`, `git`, `server` — when the entry had one. */
	scope?: string;
	/** The entry itself, first letter capitalised, author and link removed. */
	summary: string;
	breaking: boolean;
	pullNumber?: number;
	pullUrl?: string;
}

export interface ReleaseNote {
	/** `0.4.50`, no prefix. */
	version: string;
	tagName: string;
	url: string;
	publishedAt: string;
	changes: ReleaseChange[];
	/** GitHub handles from the "New Contributors" section. */
	newContributors: string[];
	/** Hand-written markdown that is not a change entry, if the release had any. */
	notes: string;
}
