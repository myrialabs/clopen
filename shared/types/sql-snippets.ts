/**
 * SQL Snippets Cloud Types
 * Shared types for the SQL snippet library feature.
 */

export interface SqlSnippet {
	id: string;
	title: string;
	description: string;
	sql: string;
	/** JSON-serialized string[] of tag labels */
	tags: string[];
	/** true = visible to all team members */
	isPublic: boolean;
	/** Unique token used in shareable links */
	shareToken: string | null;
	createdBy: string;
	createdByName: string;
	createdAt: string;
	updatedAt: string;
}

export interface SqlSnippetCreateInput {
	title: string;
	description: string;
	sql: string;
	tags: string[];
	isPublic: boolean;
}

export interface SqlSnippetUpdateInput {
	id: string;
	title: string;
	description: string;
	sql: string;
	tags: string[];
	isPublic: boolean;
}
