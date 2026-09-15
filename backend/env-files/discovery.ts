/**
 * Finding the dotenv files a project actually has.
 *
 * Ordered rather than alphabetical, and the order is the reason this is shown
 * at all: Next.js and Vite read `.env.local` IN PREFERENCE to `.env`, so a
 * project with both has exactly one right answer and picking the other produces
 * the worst outcome available — the variable is written and nothing reads it.
 */

import fs from 'fs/promises';
import { envFilePrecedence, isDotenvFileName, isTemplateEnvFile } from './keys';

export interface DotenvFileEntry {
	name: string;
	/** True for `.env.example` and friends: read for their shape, never written. */
	isTemplate: boolean;
}

/** Every dotenv-shaped file in the root, templates included, most-precedent first. */
export async function listEnvFileEntries(projectRoot: string): Promise<DotenvFileEntry[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(projectRoot);
	} catch {
		return [];
	}

	return entries
		.filter((name) => isDotenvFileName(name))
		.map((name) => ({ name, isTemplate: isTemplateEnvFile(name) }))
		.sort(
			(a, b) =>
				Number(a.isTemplate) - Number(b.isTemplate) ||
				envFilePrecedence(a.name) - envFilePrecedence(b.name) ||
				a.name.localeCompare(b.name)
		);
}

/**
 * The files a project would LOAD, most-precedent first.
 *
 * Templates are excluded. `.env.example` is documentation, and writing a live
 * password into the file a project commits is the opposite of the rule above.
 */
export async function listDotenvFiles(projectRoot: string): Promise<string[]> {
	const entries = await listEnvFileEntries(projectRoot);
	return entries.filter((entry) => !entry.isTemplate).map((entry) => entry.name);
}
