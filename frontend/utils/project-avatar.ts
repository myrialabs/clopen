/**
 * Project avatars for the sidebar: two letters and a colour per project,
 * the same in the wide and the narrow sidebar. Letters are unique across the
 * list — "clicktrainer" and "clicklander" become Ct and Cl, not CL and CL —
 * and the colour follows the name, so a project keeps it everywhere.
 */

const COLOURS = [
	'bg-violet-500/15 text-violet-700 dark:text-violet-300',
	'bg-sky-500/15 text-sky-700 dark:text-sky-300',
	'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
	'bg-amber-500/15 text-amber-700 dark:text-amber-300',
	'bg-rose-500/15 text-rose-700 dark:text-rose-300',
	'bg-teal-500/15 text-teal-700 dark:text-teal-300',
	'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
	'bg-orange-500/15 text-orange-700 dark:text-orange-300'
];

function hash(text: string): number {
	let value = 0;
	for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
	return value;
}

const letters = (name: string) => [...name.replace(/[^\p{L}\p{N}]+/gu, '')];

function defaultInitials(name: string): string {
	const words = name.split(/[\s_\-.]+/).filter(Boolean);
	if (words.length >= 2) return (letters(words[0])[0] ?? '') + (letters(words[1])[0] ?? '');
	return letters(name).slice(0, 2).join('');
}

function tidy(initials: string): string {
	return initials ? initials[0].toUpperCase() + initials.slice(1).toLowerCase() : '?';
}

export interface ProjectAvatar {
	initials: string;
	colour: string;
}

export function projectAvatars(projects: Array<{ id: string; name: string }>): Map<string, ProjectAvatar> {
	const byInitials = new Map<string, Array<{ id: string; name: string }>>();
	for (const project of projects) {
		const key = defaultInitials(project.name).toLowerCase();
		byInitials.set(key, [...(byInitials.get(key) ?? []), project]);
	}
	const result = new Map<string, ProjectAvatar>();
	for (const [key, group] of byInitials) {
		for (const project of group) {
			let initials = key;
			if (group.length > 1) {
				// First letter, then the first letter where this name parts from the others.
				const own = letters(project.name.toLowerCase());
				const others = group.filter((entry) => entry.id !== project.id).map((entry) => letters(entry.name.toLowerCase()));
				const at = own.findIndex((char, index) => index > 0 && others.every((other) => other[index] !== char));
				initials = own[0] + (at > 0 ? own[at] : (own[1] ?? ''));
			}
			result.set(project.id, { initials: tidy(initials), colour: COLOURS[hash(project.name) % COLOURS.length] });
		}
	}
	return result;
}

/** What a project's status dot means, for its tooltip. */
export function statusMeaning(colourClass: string): string {
	if (colourClass.includes('emerald')) return 'An agent is working';
	if (colourClass.includes('amber')) return 'Waiting for you';
	if (colourClass.includes('blue')) return 'New activity';
	return '';
}
