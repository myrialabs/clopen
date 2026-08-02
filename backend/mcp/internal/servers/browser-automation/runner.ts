/**
 * Batch runner.
 *
 * Walks the requested actions in order and turns them into one honest report.
 *
 * Three things it owns, each of which was a bug when it lived somewhere else:
 *
 * - **Coalescing.** Consecutive input gestures go to the native engine in a
 *   single call, so pointer movement stays continuous and the engine's own
 *   pacing applies. Split per action, a five-click sequence looks like five
 *   unrelated jumps.
 * - **Re-targeting.** Opening, switching or closing a tab changes what "the
 *   current tab" means; the target is resolved again before the next action
 *   rather than captured once at the start.
 * - **Truthful reporting.** Interrupted and failed runs say how far they got.
 *   Claiming success for actions that never ran is worse than failing, because
 *   the agent then plans on top of a state that does not exist.
 */

import type { BrowserAutonomousAction, BrowserTab } from '$backend/preview/browser/types';
import { projectContextService } from '$backend/mcp/internal/project-context';
import { debug } from '$shared/utils/logger';
import { ACTIONS_BY_TYPE } from './actions';
import type { ActionContext, ActionImage, TablessActionContext } from './actions/types';
import { getActiveTabSession, getPreviewService, peekSessionTab } from './context';

interface ActionArgs {
	type: string;
	optional?: boolean;
	[key: string]: unknown;
}

export interface RunArgs {
	actions: ActionArgs[];
	onError?: 'stop' | 'continue';
	projectId?: string;
}

interface StepReport {
	index: number;
	type: string;
	ok: boolean;
	summary?: string;
	detail?: string;
	error?: string;
}

export interface RunReport {
	steps: StepReport[];
	images: ActionImage[];
	/** Actions that never ran, because a failure or an interrupt stopped the batch. */
	skipped: number;
	aborted: boolean;
	failed: boolean;
	tabId?: string;
	url?: string;
	/** Set when the batch had to open a tab because the browser had none. */
	openedTabId?: string;
}

/** Consecutive input gestures form one native run; control actions stand alone. */
function groupActions(actions: ActionArgs[]): Array<{ kind: 'input' | 'control'; items: Array<{ index: number; args: ActionArgs }> }> {
	const groups: Array<{ kind: 'input' | 'control'; items: Array<{ index: number; args: ActionArgs }> }> = [];

	actions.forEach((args, index) => {
		const def = ACTIONS_BY_TYPE.get(args.type);
		const kind = def?.kind ?? 'control';
		const last = groups[groups.length - 1];

		if (kind === 'input' && last?.kind === 'input') {
			last.items.push({ index, args });
		} else {
			groups.push({ kind, items: [{ index, args }] });
		}
	});

	return groups;
}

export async function runActions(args: RunArgs): Promise<RunReport> {
	const signal = projectContextService.getCurrentSignal();
	const service = getPreviewService(args.projectId);
	const projectId = service.getProjectId();
	const chatSessionId = projectContextService.getCurrentChatSessionId() ?? '';

	const report: RunReport = { steps: [], images: [], skipped: 0, aborted: false, failed: false };

	let tabStale = true;
	let tab: BrowserTab | null = null;

	/** The tab to act on — opened on the spot if the browser has none. */
	const resolveTab = async () => {
		if (!tabStale && tab) return tab;
		const resolved = await getActiveTabSession(args.projectId);
		if (resolved.opened) report.openedTabId = resolved.tab.id;
		tab = resolved.tab;
		tabStale = false;
		return tab;
	};

	/** Where the batch stands, without opening anything or taking control. */
	const peekTab = () => (!tabStale && tab ? tab : peekSessionTab(service, chatSessionId));

	// `needsTab: false` actions declare their context as TablessActionContext,
	// so the null this can carry never reaches one that dereferences it.
	const makeContext = (target: BrowserTab | null): ActionContext =>
		({
			service,
			tab: target,
			projectId,
			chatSessionId,
			signal,
			invalidateTab: () => (tabStale = true)
		} satisfies TablessActionContext as ActionContext);

	const groups = groupActions(args.actions);
	let stopped = false;
	let consumed = 0;

	/** A failure only stops the batch if it was not asked to be tolerated. */
	const tolerates = (step: StepReport) =>
		args.actions[step.index]?.optional === true || args.onError === 'continue';

	for (const group of groups) {
		if (stopped || signal?.aborted) break;

		const deps: RunDeps = { args, service, signal, resolveTab, peekTab, makeContext };
		const before = report.steps.length;

		consumed += group.kind === 'input'
			? await runInputGroup(group.items, deps, report)
			: await runControl(group.items[0], deps, report);

		if (signal?.aborted) {
			report.aborted = true;
			break;
		}

		// Check every step this group produced, not just the last: one native
		// run can fail in the middle and still finish with a successful action.
		stopped = report.steps.slice(before).some((step) => !step.ok && !tolerates(step));
	}

	report.failed = report.steps.some((step) => !step.ok && !tolerates(step));
	report.skipped = Math.max(0, args.actions.length - consumed);
	if (signal?.aborted) report.aborted = true;

	// Report where the batch left the browser: the next call's plan depends on
	// it, and it is the cheapest way to notice a navigation nobody asked for.
	// Peeked, not resolved: a batch that closed its last tab should say so, not
	// get a fresh one opened just to have something to report.
	try {
		const current = peekTab();
		if (current) {
			report.tabId = current.id;
			report.url = current.page.url();
		}
	} catch {
		// No tab left (closed by the batch, or none was ever open).
	}

	return report;
}

interface RunDeps {
	args: RunArgs;
	service: ReturnType<typeof getPreviewService>;
	signal?: AbortSignal;
	resolveTab: () => Promise<BrowserTab>;
	peekTab: () => BrowserTab | null;
	makeContext: (target: BrowserTab | null) => ActionContext;
}

/** Run one control action. Returns how many actions were consumed. */
async function runControl(item: { index: number; args: ActionArgs }, deps: RunDeps, report: RunReport): Promise<number> {
	const def = ACTIONS_BY_TYPE.get(item.args.type);
	if (!def?.run) {
		report.steps.push({ index: item.index, type: item.args.type, ok: false, error: `Unknown action "${item.args.type}"` });
		return 1;
	}

	try {
		// The tab actions run on an empty browser — they are how it stops being
		// empty. Everything else gets a tab opened for it first.
		const tab = def.needsTab === false ? deps.peekTab() : await deps.resolveTab();

		const output = await def.run(item.args, deps.makeContext(tab));
		report.steps.push({ index: item.index, type: def.type, ok: true, summary: output.summary, detail: output.detail });
		if (output.images?.length) report.images.push(...output.images);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		debug.warn('mcp', `browser action ${item.args.type} failed: ${message}`);
		report.steps.push({ index: item.index, type: item.args.type, ok: false, error: message });
	}

	return 1;
}

/**
 * Run a run of input gestures as one native batch.
 *
 * The engine reports per action, so a partial run maps back onto the original
 * indices — including which of them never happened.
 */
async function runInputGroup(items: Array<{ index: number; args: ActionArgs }>, deps: RunDeps, report: RunReport): Promise<number> {
	let tab;
	try {
		tab = await deps.resolveTab();
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		report.steps.push({ index: items[0].index, type: items[0].args.type, ok: false, error: message });
		return 1;
	}

	const ctx = deps.makeContext(tab);

	// Translation can fail on its own (a path outside the project, a missing
	// field). Those actions never reach the engine, so they are reported here
	// and the rest of the group still runs.
	const primitives: BrowserAutonomousAction[] = [];
	const mapped: Array<{ index: number; type: string }> = [];

	for (const item of items) {
		const def = ACTIONS_BY_TYPE.get(item.args.type);
		if (!def?.toInput) {
			report.steps.push({ index: item.index, type: item.args.type, ok: false, error: `Unknown action "${item.args.type}"` });
			continue;
		}

		try {
			primitives.push(await def.toInput(item.args, ctx));
			mapped.push({ index: item.index, type: def.type });
		} catch (error) {
			report.steps.push({
				index: item.index,
				type: item.args.type,
				ok: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
		}
	}

	if (primitives.length === 0) return items.length;

	const outcome = await deps.service.performAutonomousActions(tab.id, primitives, deps.signal);

	// One engine result per primitive, in order.
	mapped.forEach((entry, position) => {
		const result = outcome.results[position];
		if (!result) {
			// The engine stopped before reaching this one.
			report.steps.push({ index: entry.index, type: entry.type, ok: false, error: 'did not run (batch stopped earlier)' });
			return;
		}

		report.steps.push({
			index: entry.index,
			type: entry.type,
			ok: result.ok,
			summary: result.detail,
			detail: result.data !== undefined ? JSON.stringify(result.data, null, 2) : undefined,
			error: result.error
		});
	});

	if (outcome.aborted) report.aborted = true;

	return items.length;
}
