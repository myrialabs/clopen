/**
 * Action contract.
 *
 * One module per group of actions, each exporting `ActionDef`s. The registry
 * assembles them into the tool's schema, its documentation, and the runner's
 * dispatch table — so adding an action is one file and one registry line, and
 * the three can never drift apart.
 */

import type { z } from 'zod';
import type { BrowserPreviewService } from '$backend/preview';
import type { BrowserAutonomousAction, BrowserTab } from '$backend/preview/browser/types';

export interface ActionContext {
	service: BrowserPreviewService;
	/** The tab this action targets. Re-resolved by the runner after tab changes. */
	tab: BrowserTab;
	projectId: string;
	chatSessionId: string;
	signal?: AbortSignal;
	/**
	 * Tell the runner the target tab may have changed (opened, switched,
	 * closed), so the next action resolves it again instead of driving a tab
	 * that is no longer in front.
	 */
	invalidateTab(): void;
}

/**
 * What a `needsTab: false` action gets: the same context, minus the guarantee
 * that a tab exists. `tab` is whatever the batch was last pointed at, or null
 * when the project has nothing open.
 */
export type TablessActionContext = Omit<ActionContext, 'tab'> & { tab: BrowserTab | null };

export interface ActionImage {
	data: string;
	mimeType: string;
	label?: string;
}

export interface ActionOutput {
	/** One line for the batch report, e.g. `→ https://example.com/pricing`. */
	summary: string;
	/** Payload printed under the summary (JSON dumps, log listings). */
	detail?: string;
	/** Images returned as their own content blocks, after the report. */
	images?: ActionImage[];
}

/**
 * `input` actions are gestures: the runner coalesces consecutive ones into a
 * single native run so pointer movement and inter-action timing stay smooth.
 * `control` actions run on their own — they are tab, navigation or inspection
 * operations, not input.
 */
export type ActionKind = 'input' | 'control';

export interface ActionDef {
	type: string;
	kind: ActionKind;
	/** Reference entry for this action, rendered into the tool description. */
	doc: string;
	/** Zod object whose `type` field is the discriminator. */
	schema: z.ZodObject<any>;
	/**
	 * `false` for the actions that have to work on an empty browser — the ones
	 * that open or enumerate tabs. Everything else gets a tab opened for it
	 * before it runs, so a batch never has to start with `open_tab`.
	 *
	 * Such an action must declare its context as `TablessActionContext`: that is
	 * what stops it from reading a `tab` that may be null.
	 */
	needsTab?: boolean;
	/** `input` actions: translate to the native gesture primitive. */
	toInput?: (args: any, ctx: ActionContext) => BrowserAutonomousAction | Promise<BrowserAutonomousAction>;
	/** `control` actions: run directly. */
	run?: (args: any, ctx: ActionContext) => Promise<ActionOutput>;
}
