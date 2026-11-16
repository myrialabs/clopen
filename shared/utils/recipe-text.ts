/**
 * Recipes as text — what the owner reads, what an AI writes.
 *
 * A recipe is a numbered list of plain verbs, nested by indentation:
 *
 *   # Morning email
 *   1. Use gmail.search_unread → $mail
 *   2. Do: summarise $mail in at most 5 points → $summary
 *   3. If: $summary contains "urgent"
 *      1. Tell: Urgent mail — $summary
 *      Else:
 *      1. Tell: $summary
 *
 * The verbs are a small fixed English vocabulary (Do, Run, HTTP, Use, Tell,
 * Ask, Approve, If, Choose, For each, In parallel, Repeat until, Review, Flow,
 * Wait); branch markers — `Else:`, `Case …:`, `Otherwise:`, `Branch:` — sit at
 * the children's indentation. Only the structure is English: the owner talks
 * to Clopen in any language, the AI writes the recipe in this canonical form,
 * and the content of a step (a goal, a message) stays in whatever language it
 * was written in.
 *
 * The parser is forgiving on purpose: a small model that writes "2) do -
 * summarise" still gets a valid recipe. `normaliseRecipe` does the same for
 * JSON, accepting the aliases models reach for (`type` for `kind`, `prompt`
 * for `goal`, `steps` for `then`…). What cannot be understood is reported with
 * the line, never silently dropped.
 */

import type { Recipe, RecipeStep } from '$shared/types/recipe';

export class RecipeError extends Error {}

interface Line {
	indent: number;
	text: string;
	number: number;
}

const VERBS: Array<{ kind: RecipeStep['kind']; words: string[] }> = [
	{ kind: 'repeat', words: ['repeat until', 'loop until'] },
	{ kind: 'each', words: ['for each', 'each'] },
	{ kind: 'parallel', words: ['in parallel', 'parallel'] },
	{ kind: 'approve', words: ['approve', 'approval'] },
	{ kind: 'review', words: ['review'] },
	{ kind: 'choose', words: ['choose', 'classify'] },
	{ kind: 'if', words: ['if'] },
	{ kind: 'do', words: ['do'] },
	{ kind: 'run', words: ['run script', 'run'] },
	{ kind: 'http', words: ['http', 'fetch'] },
	{ kind: 'use', words: ['use'] },
	{ kind: 'tell', words: ['tell', 'notify', 'send'] },
	{ kind: 'ask', words: ['ask'] },
	{ kind: 'flow', words: ['flow'] },
	{ kind: 'wait', words: ['wait'] }
];

const MARKERS: Array<{ marker: 'else' | 'case' | 'otherwise' | 'branch'; words: string[] }> = [
	{ marker: 'otherwise', words: ['otherwise'] },
	{ marker: 'else', words: ['else'] },
	{ marker: 'case', words: ['case'] },
	{ marker: 'branch', words: ['branch'] }
];

function lines(text: string): Line[] {
	return text
		.replace(/\t/g, '   ')
		.split('\n')
		.map((raw, index) => ({ raw, number: index + 1 }))
		.filter(({ raw }) => raw.trim() && !raw.trim().startsWith('<!--'))
		.map(({ raw, number }) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim(), number }));
}

/** Drop a leading "1.", "1)", "-", "*" bullet. */
function stripBullet(text: string): string {
	return text.replace(/^(\d+[.)]|[-*•])\s+/, '');
}

/** Split "text → $name" (or "-> $name", "as $name"). */
function splitName(text: string): { text: string; name?: string } {
	const match = /\s*(?:→|->|=>|\bas\b)\s*\$([A-Za-z_][\w-]*)\s*$/i.exec(text);
	if (!match) return { text };
	return { text: text.slice(0, match.index).trim(), name: match[1] };
}

function matchVerb(text: string): { kind: RecipeStep['kind']; rest: string } | null {
	const lower = text.toLowerCase();
	for (const verb of VERBS) {
		for (const word of verb.words) {
			if (lower === word || lower.startsWith(`${word}:`) || lower.startsWith(`${word} `) || lower.startsWith(`${word} -`)) {
				const rest = text.slice(word.length).replace(/^\s*[:\-–—]?\s*/, '');
				return { kind: verb.kind, rest };
			}
		}
	}
	return null;
}

function matchMarker(text: string): { marker: 'else' | 'case' | 'otherwise' | 'branch'; label: string } | null {
	const lower = text.toLowerCase();
	if (!lower.endsWith(':') && !/:\s*$/.test(lower)) {
		// "Case invoice:" needs the colon; a bare "Else" is fine too.
		if (!['else', 'otherwise', 'branch'].includes(lower)) return null;
	}
	for (const marker of MARKERS) {
		for (const word of marker.words) {
			if (lower.startsWith(word)) {
				const label = text
					.slice(word.length)
					.replace(/:\s*$/, '')
					.trim()
					.replace(/^["']|["']$/g, '');
				return { marker: marker.marker, label };
			}
		}
	}
	return null;
}

/** "(as Developer in cafe-web)" at the end of a goal. */
function splitRole(text: string): { text: string; role?: string; project?: string } {
	const match = /\s*\(as\s+([^)]*?)(?:\s+in\s+([^)]+))?\)\s*$/i.exec(text);
	if (!match) return { text };
	return { text: text.slice(0, match.index).trim(), role: match[1].trim() || undefined, project: match[2]?.trim() || undefined };
}

function parseOptions(text: string): { text: string; options?: string[] } {
	const match = /\s*\[([^\]]+)\]\s*$/.exec(text);
	if (!match) return { text };
	return { text: text.slice(0, match.index).trim(), options: match[1].split('|').map((option) => option.trim()).filter(Boolean) };
}

function buildStep(kind: RecipeStep['kind'], rest: string, name: string | undefined, line: Line): RecipeStep {
	const base = name ? { name } : {};
	switch (kind) {
		case 'do': {
			const { text, role, project } = splitRole(rest);
			if (!text) throw new RecipeError(`Line ${line.number}: "Do" needs a goal.`);
			return { kind, goal: text, ...(role ? { role } : {}), ...(project ? { project } : {}), ...base };
		}
		case 'run': {
			const [script, ...args] = rest.split(/\s+/).filter(Boolean);
			if (!script) throw new RecipeError(`Line ${line.number}: "Run" needs a script name.`);
			return { kind, script, ...(args.length ? { args } : {}), ...base };
		}
		case 'http': {
			const match = /^(GET|POST|PUT|PATCH|DELETE)?\s*(\S+)(?:\s+(.*))?$/i.exec(rest);
			if (!match?.[2]) throw new RecipeError(`Line ${line.number}: "HTTP" needs a URL.`);
			return { kind, method: (match[1] ?? 'GET').toUpperCase(), url: match[2], ...(match[3] ? { body: match[3] } : {}), ...base };
		}
		case 'use': {
			const match = /^([\w-]+)[.\s/]+([\w-]+)\s*(?::\s*)?(\{[\s\S]*\})?\s*$/.exec(rest);
			if (!match) throw new RecipeError(`Line ${line.number}: write "Use service.tool" (optionally followed by JSON arguments).`);
			let args: Record<string, unknown> | undefined;
			if (match[3]) {
				try {
					args = JSON.parse(match[3]);
				} catch {
					throw new RecipeError(`Line ${line.number}: the arguments after "Use ${match[1]}.${match[2]}" are not valid JSON.`);
				}
			}
			return { kind, service: match[1], tool: match[2], ...(args ? { args } : {}), ...base };
		}
		case 'tell':
			return { kind, text: rest, ...base };
		case 'ask': {
			const { text, options } = parseOptions(rest);
			return { kind, question: text, ...(options ? { options } : {}), ...base };
		}
		case 'approve':
			return { kind, what: rest, ...base };
		case 'flow':
			return { kind, flow: rest.replace(/^["']|["']$/g, ''), ...base };
		case 'wait': {
			const minutes = Number(/(\d+(?:\.\d+)?)/.exec(rest)?.[1] ?? 0);
			const hours = /\b(h|hr|hrs|hour|hours)\b/i.test(rest);
			return { kind, minutes: hours ? minutes * 60 : minutes || 1, ...base };
		}
		case 'review': {
			const match = /^(\$[\w.-]+)\s+by\s+([^:—–]+)(?:\s*[:—–]\s*(.*))?$/i.exec(rest);
			if (!match) throw new RecipeError(`Line ${line.number}: write "Review $result by Role, Role: what to check".`);
			const reviewers = match[2].split(/,|\band\b/).map((role) => role.trim()).filter(Boolean);
			return { kind, target: match[1], reviewers, ...(match[3] ? { criteria: match[3].trim() } : {}), ...base };
		}
		case 'if':
			return { kind, when: rest, then: [], ...base };
		case 'choose':
			return { kind, by: rest, cases: [], ...base };
		case 'each':
			return { kind, items: rest, steps: [], ...base };
		case 'parallel':
			return { kind, branches: [], ...base };
		case 'repeat':
			return { kind, until: rest, steps: [], ...base };
	}
}

function parseBlock(all: Line[], start: number, indent: number): { steps: RecipeStep[]; next: number } {
	const steps: RecipeStep[] = [];
	let index = start;
	while (index < all.length && all[index].indent >= indent) {
		const line = all[index];
		if (line.indent > indent && steps.length === 0) {
			// Deeper than expected at the start: treat as this level.
			indent = line.indent;
		}
		if (line.indent > indent) throw new RecipeError(`Line ${line.number}: unexpected indentation.`);
		const text = stripBullet(line.text);
		const marker = matchMarker(text);
		if (marker && steps.length > 0) {
			// Written like code — "Else:" level with its "If", its steps deeper — it still belongs to that If.
			const owner = steps[steps.length - 1];
			const deeper = index + 1 < all.length && all[index + 1].indent > line.indent;
			const target = deeper ? openBranch(owner, marker) : null;
			if (!target) break;
			const block = parseBlock(all, index + 1, all[index + 1].indent);
			target.push(...block.steps);
			index = block.next;
			continue;
		}
		const { text: body, name } = splitName(text);
		const verb = matchVerb(body);
		if (!verb) throw new RecipeError(`Line ${line.number}: "${line.text}" does not start with a step (Do, Run, Use, Tell, Ask, If, …).`);
		const step = buildStep(verb.kind, verb.rest, name, line);
		index += 1;
		const childIndent = index < all.length && all[index].indent > line.indent ? all[index].indent : null;
		if (childIndent !== null && ['if', 'choose', 'each', 'parallel', 'repeat'].includes(step.kind)) {
			index = parseChildren(step, all, index, childIndent);
		} else if (childIndent !== null) {
			throw new RecipeError(`Line ${all[index].number}: only If, Choose, For each, In parallel and Repeat can contain steps.`);
		}
		steps.push(step);
	}
	return { steps, next: index };
}

/** The list a branch marker opens on a step (a new Else, Case, Otherwise or Branch), or null when it does not fit. */
function openBranch(step: RecipeStep, marker: { marker: 'else' | 'case' | 'otherwise' | 'branch'; label: string }): RecipeStep[] | null {
	if (step.kind === 'if' && marker.marker === 'else' && !step.else) return (step.else = []);
	if (step.kind === 'if' && marker.marker === 'otherwise' && !step.else) return (step.else = []);
	if (step.kind === 'choose' && marker.marker === 'case') {
		const target: RecipeStep[] = [];
		step.cases.push({ label: marker.label || `case ${step.cases.length + 1}`, steps: target });
		return target;
	}
	if (step.kind === 'choose' && (marker.marker === 'otherwise' || marker.marker === 'else') && !step.otherwise) return (step.otherwise = []);
	if (step.kind === 'parallel' && marker.marker === 'branch') {
		const target: RecipeStep[] = [];
		step.branches.push(target);
		return target;
	}
	return null;
}

/**
 * "Else if <condition>:" is an Else holding an If. Rewritten into exactly
 * that before parsing, nested a hair deeper each time so the next "Else" of
 * the same chain lands on the innermost If.
 */
function expandElseIf(all: Line[]): Line[] {
	const out: Line[] = [];
	/**
	 * Chains by the indentation their markers sit at: how many else-ifs so far,
	 * and whether a branch's steps sit level with its marker (the canonical
	 * form) rather than deeper (the code-like form).
	 */
	const chains = new Map<number, { depth: number; flat: boolean }>();
	const STEP = 0.01;
	for (const [index, line] of all.entries()) {
		const text = stripBullet(line.text);
		const elseIf = /^(?:else\s*if|elif|otherwise\s+if)\b\s*[:\-–—]?\s*(.+?)\s*:?\s*$/i.exec(text);
		const marker = Boolean(elseIf) || Boolean(matchMarker(text));
		for (const [indent, chain] of [...chains]) {
			if (indent > line.indent || (indent === line.indent && !marker && !chain.flat)) chains.delete(indent);
		}
		const chain = chains.get(line.indent);
		const depth = chain?.depth ?? 0;
		if (elseIf) {
			const next = all[index + 1];
			const flat = !next || next.indent <= line.indent;
			out.push({ indent: line.indent + depth * STEP, text: 'Else:', number: line.number });
			out.push({ indent: line.indent + (depth + 1) * STEP, text: `If: ${elseIf[1]}`, number: line.number });
			chains.set(line.indent, { depth: depth + 1, flat });
		} else if (chain && marker) {
			out.push({ ...line, indent: line.indent + depth * STEP });
		} else if (chain) {
			// A step level with the chain's markers, in the canonical form: it belongs to the innermost branch.
			out.push({ ...line, indent: line.indent + (depth + 1) * STEP });
		} else {
			out.push(line);
		}
	}
	return out;
}

function parseChildren(step: RecipeStep, all: Line[], start: number, indent: number): number {
	let index = start;
	let current: RecipeStep[] = [];
	const assign = (target: RecipeStep[]) => (current = target);

	if (step.kind === 'if') assign(step.then);
	else if (step.kind === 'each' || step.kind === 'repeat') assign(step.steps);
	else if (step.kind === 'parallel') {
		step.branches.push([]);
		assign(step.branches[0]);
	}

	while (index < all.length && all[index].indent >= indent) {
		const line = all[index];
		const marker = line.indent === indent ? matchMarker(stripBullet(line.text)) : null;
		if (marker) {
			index += 1;
			if (step.kind === 'if' && marker.marker === 'else') {
				step.else = [];
				assign(step.else);
			} else if (step.kind === 'choose' && marker.marker === 'case') {
				const target: RecipeStep[] = [];
				step.cases.push({ label: marker.label || `case ${step.cases.length + 1}`, steps: target });
				assign(target);
			} else if (step.kind === 'choose' && (marker.marker === 'otherwise' || marker.marker === 'else')) {
				step.otherwise = [];
				assign(step.otherwise);
			} else if (step.kind === 'parallel' && marker.marker === 'branch') {
				if (step.branches[step.branches.length - 1].length > 0) step.branches.push([]);
				assign(step.branches[step.branches.length - 1]);
			} else {
				throw new RecipeError(`Line ${line.number}: "${line.text}" does not belong under ${step.kind}.`);
			}
			continue;
		}
		if (step.kind === 'choose' && current.length === 0 && step.cases.length === 0 && !step.otherwise) {
			throw new RecipeError(`Line ${line.number}: start each choice with "Case <label>:".`);
		}
		const block = parseBlock(all, index, line.indent);
		current.push(...block.steps);
		index = block.next;
	}
	return index;
}

/** Parse recipe text. The first `# heading` (if any) is the title. */
export function parseRecipeText(text: string, fallbackTitle = 'Untitled'): Recipe {
	const all = lines(text);
	let title = fallbackTitle;
	const body = all.filter((line) => {
		if (/^#\s+/.test(line.text) && title === fallbackTitle) {
			title = line.text.replace(/^#\s+/, '').trim();
			return false;
		}
		// Frontmatter-ish lines the caller handles ("When: …") are not steps.
		return !/^(when|trigger|---)\b/i.test(line.text);
	});
	if (body.length === 0) throw new RecipeError('The recipe has no steps.');
	const expanded = expandElseIf(body);
	const { steps, next } = parseBlock(expanded, 0, expanded[0].indent);
	if (next < expanded.length) throw new RecipeError(`Line ${expanded[next].number}: could not read "${expanded[next].text}".`);
	return { title, steps };
}

// ── Writing ────────────────────────────────────────────────────────────────

function named(step: RecipeStep): string {
	return step.name ? ` → $${step.name}` : '';
}

function stepLine(step: RecipeStep): string {
	switch (step.kind) {
		case 'do': {
			const who = step.role || step.project ? ` (as ${step.role ?? 'Agent'}${step.project ? ` in ${step.project}` : ''})` : '';
			return `Do: ${step.goal}${who}`;
		}
		case 'run':
			return `Run: ${[step.script, ...(step.args ?? [])].join(' ')}`;
		case 'http':
			return `HTTP ${step.method ?? 'GET'} ${step.url}${step.body ? ` ${step.body}` : ''}`;
		case 'use':
			return `Use ${step.service}.${step.tool}${step.args && Object.keys(step.args).length ? `: ${JSON.stringify(step.args)}` : ''}`;
		case 'tell':
			return `Tell: ${step.text}`;
		case 'ask':
			return `Ask: ${step.question}${step.options?.length ? ` [${step.options.join(' | ')}]` : ''}`;
		case 'approve':
			return `Approve: ${step.what}`;
		case 'if':
			return `If: ${step.when}`;
		case 'choose':
			return `Choose: ${step.by}`;
		case 'each':
			return `For each: ${step.items}`;
		case 'parallel':
			return 'In parallel:';
		case 'repeat':
			return `Repeat until: ${step.until}`;
		case 'review':
			return `Review ${step.target} by ${step.reviewers.join(', ')}${step.criteria ? `: ${step.criteria}` : ''}`;
		case 'flow':
			return `Flow: ${step.flow}`;
		case 'wait':
			return `Wait: ${step.minutes} min`;
	}
}

function writeSteps(steps: RecipeStep[], depth: number, out: string[]): void {
	const pad = '   '.repeat(depth);
	const childPad = '   '.repeat(depth + 1);
	steps.forEach((step, index) => {
		out.push(`${pad}${index + 1}. ${stepLine(step)}${named(step)}`);
		switch (step.kind) {
			case 'if':
				writeSteps(step.then, depth + 1, out);
				if (step.else?.length) {
					out.push(`${childPad}Else:`);
					writeSteps(step.else, depth + 1, out);
				}
				break;
			case 'choose':
				for (const entry of step.cases) {
					out.push(`${childPad}Case ${entry.label}:`);
					writeSteps(entry.steps, depth + 1, out);
				}
				if (step.otherwise?.length) {
					out.push(`${childPad}Otherwise:`);
					writeSteps(step.otherwise, depth + 1, out);
				}
				break;
			case 'each':
			case 'repeat':
				writeSteps(step.steps, depth + 1, out);
				break;
			case 'parallel':
				step.branches.forEach((branch, branchIndex) => {
					if (branchIndex > 0 || step.branches.length > 1) out.push(`${childPad}Branch:`);
					writeSteps(branch, depth + 1, out);
				});
				break;
		}
	});
}

export function recipeToText(recipe: Recipe): string {
	const out = [`# ${recipe.title}`];
	writeSteps(recipe.steps, 0, out);
	return out.join('\n');
}

// ── JSON, forgivingly ──────────────────────────────────────────────────────

const KIND_ALIASES: Record<string, RecipeStep['kind']> = {
	do: 'do',
	ai: 'do',
	agent: 'do',
	prompt: 'do',
	task: 'do',
	run: 'run',
	script: 'run',
	http: 'http',
	fetch: 'http',
	request: 'http',
	use: 'use',
	tool: 'use',
	mcp: 'use',
	tell: 'tell',
	notify: 'tell',
	send: 'tell',
	message: 'tell',
	ask: 'ask',
	question: 'ask',
	approve: 'approve',
	approval: 'approve',
	if: 'if',
	condition: 'if',
	choose: 'choose',
	switch: 'choose',
	classify: 'choose',
	each: 'each',
	foreach: 'each',
	for_each: 'each',
	parallel: 'parallel',
	repeat: 'repeat',
	loop: 'repeat',
	review: 'review',
	flow: 'flow',
	recipe: 'flow',
	wait: 'wait',
	delay: 'wait'
};

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stepsOf(value: unknown, path: string): RecipeStep[] {
	if (value === undefined || value === null) return [];
	if (typeof value === 'string') return parseRecipeText(value).steps;
	if (!Array.isArray(value)) throw new RecipeError(`${path} must be a list of steps.`);
	return value.map((item, index) => normaliseStep(item, `${path}[${index}]`));
}

/** One step from loosely shaped JSON. */
export function normaliseStep(raw: unknown, path = 'step'): RecipeStep {
	if (typeof raw === 'string') {
		const parsed = parseRecipeText(raw).steps;
		if (parsed.length !== 1) throw new RecipeError(`${path}: one step per item.`);
		return parsed[0];
	}
	if (!raw || typeof raw !== 'object') throw new RecipeError(`${path} must be an object or a line of text.`);
	const value = raw as Record<string, unknown>;
	const kindRaw = String(value.kind ?? value.type ?? value.step ?? value.action ?? '').toLowerCase().replace(/[\s-]/g, '_');
	const kind = KIND_ALIASES[kindRaw];
	if (!kind) throw new RecipeError(`${path}: unknown kind "${kindRaw || '(missing)'}". Use one of: do, run, http, use, tell, ask, approve, if, choose, each, parallel, repeat, review, flow, wait.`);
	const base = {
		...(str(value.name ?? value.as) ? { name: str(value.name ?? value.as)!.replace(/^\$/, '') } : {}),
		...(value.optional === true ? { optional: true } : {}),
		...(str(value.title) ? { title: str(value.title) } : {})
	};
	const text = str(value.goal ?? value.prompt ?? value.text ?? value.task ?? value.what ?? value.message);
	switch (kind) {
		case 'do':
			if (!text) throw new RecipeError(`${path}: "do" needs a goal.`);
			return { kind, goal: text, ...(str(value.role) ? { role: str(value.role) } : {}), ...(str(value.project) ? { project: str(value.project) } : {}), ...(value.fresh === true ? { fresh: true } : {}), ...base };
		case 'run': {
			const script = str(value.script ?? value.name_of_script ?? value.command);
			if (!script) throw new RecipeError(`${path}: "run" needs a script.`);
			const args = Array.isArray(value.args) ? value.args.map(String) : undefined;
			return { kind, script, ...(args ? { args } : {}), ...base };
		}
		case 'http': {
			const url = str(value.url);
			if (!url) throw new RecipeError(`${path}: "http" needs a url.`);
			return { kind, url, method: (str(value.method) ?? 'GET').toUpperCase(), ...(value.headers && typeof value.headers === 'object' ? { headers: value.headers as Record<string, string> } : {}), ...(value.body !== undefined ? { body: typeof value.body === 'string' ? value.body : JSON.stringify(value.body) } : {}), ...base };
		}
		case 'use': {
			let service = str(value.service ?? value.server);
			let tool = str(value.tool);
			if (service && !tool && service.includes('.')) [service, tool] = service.split('.', 2);
			if (!service || !tool) throw new RecipeError(`${path}: "use" needs service and tool.`);
			return { kind, service, tool, ...(value.args && typeof value.args === 'object' ? { args: value.args as Record<string, unknown> } : {}), ...base };
		}
		case 'tell':
			return { kind, text: text ?? '', ...(Array.isArray(value.files) ? { files: value.files.map(String) } : {}), ...base };
		case 'ask':
			return { kind, question: str(value.question) ?? text ?? '', ...(Array.isArray(value.options) ? { options: value.options.map(String) } : {}), ...base };
		case 'approve':
			return { kind, what: text ?? 'Continue?', ...base };
		case 'if': {
			const when = str(value.when ?? value.condition ?? value.if);
			if (!when) throw new RecipeError(`${path}: "if" needs a condition in "when".`);
			const otherwise = stepsOf(value.else ?? value.otherwise, `${path}.else`);
			return { kind, when, then: stepsOf(value.then ?? value.steps ?? value.do, `${path}.then`), ...(otherwise.length ? { else: otherwise } : {}), ...base };
		}
		case 'choose': {
			const by = str(value.by ?? value.what ?? value.on);
			if (!by) throw new RecipeError(`${path}: "choose" needs "by" (what to sort).`);
			let cases: Array<{ label: string; steps: RecipeStep[] }> = [];
			if (Array.isArray(value.cases)) {
				cases = value.cases.map((entry, index) => {
					const item = entry as Record<string, unknown>;
					return { label: String(item.label ?? item.case ?? item.when ?? `case ${index + 1}`), steps: stepsOf(item.steps ?? item.then ?? item.do, `${path}.cases[${index}]`) };
				});
			} else if (value.cases && typeof value.cases === 'object') {
				cases = Object.entries(value.cases as Record<string, unknown>).map(([label, steps]) => ({ label, steps: stepsOf(steps, `${path}.cases.${label}`) }));
			}
			if (!cases.length) throw new RecipeError(`${path}: "choose" needs at least one case.`);
			const otherwise = stepsOf(value.otherwise ?? value.else ?? value.default, `${path}.otherwise`);
			return { kind, by, cases, ...(otherwise.length ? { otherwise } : {}), ...base };
		}
		case 'each': {
			const items = str(value.items ?? value.in ?? value.over);
			if (!items) throw new RecipeError(`${path}: "each" needs "items" (a result like $list).`);
			return { kind, items, steps: stepsOf(value.steps ?? value.do, `${path}.steps`), ...base };
		}
		case 'parallel': {
			const branches = Array.isArray(value.branches) ? value.branches.map((branch, index) => stepsOf(branch, `${path}.branches[${index}]`)) : [];
			if (!branches.length) throw new RecipeError(`${path}: "parallel" needs branches.`);
			return { kind, branches, ...base };
		}
		case 'repeat': {
			const until = str(value.until ?? value.condition);
			if (!until) throw new RecipeError(`${path}: "repeat" needs "until".`);
			return { kind, until, steps: stepsOf(value.steps ?? value.do, `${path}.steps`), ...(typeof value.max === 'number' ? { max: value.max } : {}), ...base };
		}
		case 'review': {
			const target = str(value.target ?? value.of ?? value.result);
			const reviewers = Array.isArray(value.reviewers) ? value.reviewers.map(String) : typeof value.reviewers === 'string' ? value.reviewers.split(',').map((role) => role.trim()) : [];
			if (!target || !reviewers.length) throw new RecipeError(`${path}: "review" needs a target and reviewers.`);
			return { kind, target: target.startsWith('$') ? target : `$${target}`, reviewers, ...(str(value.criteria) ? { criteria: str(value.criteria) } : {}), ...base };
		}
		case 'flow': {
			const flow = str(value.flow ?? value.recipe ?? value.name_of_flow ?? text);
			if (!flow) throw new RecipeError(`${path}: "flow" needs the flow's name.`);
			return { kind, flow, ...base };
		}
		case 'wait':
			return { kind, minutes: Number(value.minutes ?? value.min ?? 1) || 1, ...base };
	}
}

/** A recipe from text, a list of steps, or `{ title, steps }`. */
export function normaliseRecipe(raw: unknown, fallbackTitle = 'Untitled'): Recipe {
	if (typeof raw === 'string') return parseRecipeText(raw, fallbackTitle);
	if (Array.isArray(raw)) return { title: fallbackTitle, steps: stepsOf(raw, 'steps') };
	if (raw && typeof raw === 'object') {
		const value = raw as Record<string, unknown>;
		const steps = stepsOf(value.steps, 'steps');
		if (!steps.length) throw new RecipeError('The recipe has no steps.');
		return { title: str(value.title ?? value.name) ?? fallbackTitle, steps };
	}
	throw new RecipeError('A recipe is text or { title, steps }.');
}

/** Every step, depth-first, with its path ("2", "3.then.1"). */
export function walkSteps(steps: RecipeStep[], prefix = ''): Array<{ step: RecipeStep; path: string }> {
	const out: Array<{ step: RecipeStep; path: string }> = [];
	steps.forEach((step, index) => {
		const path = prefix ? `${prefix}.${index + 1}` : String(index + 1);
		out.push({ step, path });
		if (step.kind === 'if') {
			out.push(...walkSteps(step.then, `${path}.then`));
			if (step.else) out.push(...walkSteps(step.else, `${path}.else`));
		} else if (step.kind === 'choose') {
			step.cases.forEach((entry) => out.push(...walkSteps(entry.steps, `${path}.${entry.label}`)));
			if (step.otherwise) out.push(...walkSteps(step.otherwise, `${path}.otherwise`));
		} else if (step.kind === 'each' || step.kind === 'repeat') {
			out.push(...walkSteps(step.steps, path));
		} else if (step.kind === 'parallel') {
			step.branches.forEach((branch, branchIndex) => out.push(...walkSteps(branch, `${path}.b${branchIndex + 1}`)));
		}
	});
	return out;
}
