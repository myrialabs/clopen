/**
 * Recipes — how Clopen does a piece of work, step by step.
 *
 * One shape for three things: a Flow (a recipe with a trigger: a schedule, a
 * watched page, an event), a task's crew (the stages a team of specialists
 * goes through, with reviews), and anything the owner writes themselves.
 *
 * Steps are plain verbs a non-programmer can read. A step's result is kept
 * under its `name` (or `s1`, `s2`…) and referred to later as `$name` or
 * `$name.field`. Recipes change as they run: Clopen repairs a failing step,
 * adds a branch for a case it met, and freezes an AI step that always gives
 * the same answer into a script — every change a new version.
 */

export type RecipeStep =
	| DoStep
	| RunStep
	| HttpStep
	| UseStep
	| TellStep
	| AskStep
	| ApproveStep
	| IfStep
	| ChooseStep
	| EachStep
	| ParallelStep
	| RepeatStep
	| ReviewStep
	| FlowStep
	| WaitStep;

interface StepBase {
	/** Result name, referred to as `$name`. Defaults to `s<position>`. */
	name?: string;
	/** Skip failures of this step instead of stopping the run. */
	optional?: boolean;
	/** A short human title for the canvas ("Build it", "Test in the browser"); the step's own text otherwise. */
	title?: string;
}

/** A goal for an AI agent — it decides how. */
export interface DoStep extends StepBase {
	kind: 'do';
	goal: string;
	/** The specialist doing it ("Developer", "Researcher"…). */
	role?: string;
	/** Project (name, id or path) to work in; Clopen's own chat when absent. */
	project?: string;
	/** Use a fresh chat instead of continuing the role's chat. */
	fresh?: boolean;
}

/** A saved script — exact, no AI, no tokens. */
export interface RunStep extends StepBase {
	kind: 'run';
	script: string;
	args?: string[];
}

export interface HttpStep extends StepBase {
	kind: 'http';
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

/** A tool of a connected service (an MCP server): Gmail, Notion, Sheets… */
export interface UseStep extends StepBase {
	kind: 'use';
	service: string;
	tool: string;
	args?: Record<string, unknown>;
}

/** Send the owner a message (and files). */
export interface TellStep extends StepBase {
	kind: 'tell';
	text: string;
	files?: string[];
}

/** Ask the owner and wait for the answer. */
export interface AskStep extends StepBase {
	kind: 'ask';
	question: string;
	options?: string[];
}

/** Wait for the owner's OK; a "no" ends the run. */
export interface ApproveStep extends StepBase {
	kind: 'approve';
	what: string;
}

/**
 * `when` is either a check on a result (`$price > 100`, `$mail contains
 * "invoice"`, `$list is empty`) or a plain question an AI answers yes/no.
 */
export interface IfStep extends StepBase {
	kind: 'if';
	when: string;
	then: RecipeStep[];
	else?: RecipeStep[];
}

/** Sort something into one of several cases (an AI decides which). */
export interface ChooseStep extends StepBase {
	kind: 'choose';
	by: string;
	cases: Array<{ label: string; steps: RecipeStep[] }>;
	otherwise?: RecipeStep[];
}

/** Run the steps once per item of a list result. */
export interface EachStep extends StepBase {
	kind: 'each';
	items: string;
	steps: RecipeStep[];
}

export interface ParallelStep extends StepBase {
	kind: 'parallel';
	branches: RecipeStep[][];
}

/** Repeat the steps until the condition holds (checked after each round). */
export interface RepeatStep extends StepBase {
	kind: 'repeat';
	until: string;
	steps: RecipeStep[];
	/** Safety stop; the default is generous — a loop that stops making progress ends on its own. */
	max?: number;
}

/** A panel of reviewers judges a result; `$name.passed` and `$name.issues`. */
export interface ReviewStep extends StepBase {
	kind: 'review';
	target: string;
	reviewers: string[];
	criteria?: string;
}

/** Run another saved flow as one step. */
export interface FlowStep extends StepBase {
	kind: 'flow';
	flow: string;
}

export interface WaitStep extends StepBase {
	kind: 'wait';
	minutes: number;
}

export interface Recipe {
	title: string;
	steps: RecipeStep[];
}

export type RecipeStepKind = RecipeStep['kind'];

/** One line of a run's trace — what a step did. */
export interface RecipeTraceEntry {
	path: string;
	kind: RecipeStepKind;
	label: string;
	status: 'ok' | 'failed' | 'skipped' | 'repaired';
	output?: string;
	error?: string;
	startedAt: string;
	ms: number;
	costUsd?: number;
}

export interface RecipeVersion {
	version: number;
	note: string;
	createdBy: string;
	createdAt: string;
}
