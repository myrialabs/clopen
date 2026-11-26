/**
 * Credentials already on this machine: the `gh`, `glab` and `tea` CLIs, and
 * git's own credential store (the system keychain, Git Credential Manager).
 *
 * ── Never silently ──
 * Detection only REPORTS what it found. Nothing here creates an account; the
 * connect dialog shows "Found gh signed in as @you — use it?" and the user
 * decides. A tool that quietly picked up whatever token lay around would
 * authenticate as an account nobody chose.
 *
 * ── Linked, not copied ──
 * A CLI login can be re-asked on every use (`gh auth token`), so an account
 * connected that way stores which CLI and host it came from and re-reads the
 * token rather than keeping its own copy. Logging out or rotating in the CLI is
 * then followed here, which is what a user who "uses their gh login" expects.
 * The keychain is the exception — reading it can raise an OS prompt, so it is
 * read once, on an explicit click, and copied.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DetectedCredential, GitHostKind } from '$shared/types/git-hosting';
import { debug } from '$shared/utils/logger';

export type CliTool = 'gh' | 'glab' | 'tea';

const CLI_FOR: Partial<Record<GitHostKind, CliTool>> = {
	github: 'gh',
	gitlab: 'glab',
	gitea: 'tea'
};

export function cliForProvider(provider: GitHostKind): CliTool | null {
	return CLI_FOR[provider] ?? null;
}

const CLI_TIMEOUT_MS = 8_000;

/**
 * The environment a child CLI runs with.
 *
 * Clopen's own git identity variables are stripped: they are meant for git
 * commands Clopen runs on a project, and `git credential fill` inheriting them
 * would ask CLOPEN's helper — reporting our own stored token back as if the
 * machine had it.
 */
function childEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key === 'GIT_CONFIG_COUNT' || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) continue;
		if (key === 'GIT_CONFIG_GLOBAL' || key === 'GIT_ASKPASS' || key === 'SSH_ASKPASS') continue;
		env[key] = value;
	}
	env.GH_PROMPT_DISABLED = '1';
	env.NO_COLOR = '1';
	env.GIT_TERMINAL_PROMPT = '0';
	env.GCM_INTERACTIVE = 'never';
	return env;
}

async function run(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string } | null> {
	const binary = Bun.which(command);
	if (!binary) return null;
	try {
		const proc = Bun.spawn([binary, ...args], {
			stdin: input !== undefined ? new TextEncoder().encode(input) : 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env: childEnv()
		});
		const timer = setTimeout(() => proc.kill(), CLI_TIMEOUT_MS);
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		clearTimeout(timer);
		return { code, stdout };
	} catch (error) {
		debug.warn('git-hosts', `Could not run ${command}:`, error);
		return null;
	}
}

function configHome(): string {
	return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
}

function readText(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, 'utf8') : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Config parsing. These files are YAML, but only a tiny, regular subset of it;
// a YAML dependency for three top-level shapes is not worth its tree.
// ---------------------------------------------------------------------------

/**
 * `gh`'s hosts.yml: one top-level key per host, with `user:` beneath it.
 *
 *   github.com:
 *       user: octocat
 *       git_protocol: https
 */
export function parseGhHosts(text: string): { host: string; login: string | null }[] {
	const hosts: { host: string; login: string | null }[] = [];
	let current: { host: string; login: string | null } | null = null;
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '');
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const top = /^([^\s#][^:]*):\s*$/.exec(line);
		if (top) {
			current = { host: top[1]!.trim().replace(/^["']|["']$/g, '').toLowerCase(), login: null };
			hosts.push(current);
			continue;
		}
		const user = /^\s+user:\s*(\S+)\s*$/.exec(line);
		if (user && current && !current.login) current.login = user[1]!.replace(/^["']|["']$/g, '');
	}
	return hosts;
}

/**
 * `glab`'s config.yml: hosts nested under `hosts:`.
 *
 *   hosts:
 *       gitlab.com:
 *           token: glpat-…
 *           user: octocat
 */
export function parseGlabHosts(text: string): { host: string; login: string | null; hasToken: boolean }[] {
	const hosts: { host: string; login: string | null; hasToken: boolean }[] = [];
	let inHosts = false;
	let hostIndent = -1;
	let current: { host: string; login: string | null; hasToken: boolean } | null = null;
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '');
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const indent = line.length - line.trimStart().length;
		if (indent === 0) {
			inHosts = /^hosts:\s*$/.test(line);
			current = null;
			hostIndent = -1;
			continue;
		}
		if (!inHosts) continue;
		const key = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
		if (!key) continue;
		if (hostIndent === -1 || indent === hostIndent) {
			if (key[2]!.trim() === '') {
				hostIndent = indent;
				current = { host: key[1]!.replace(/^["']|["']$/g, '').toLowerCase(), login: null, hasToken: false };
				hosts.push(current);
			}
			continue;
		}
		if (!current) continue;
		const value = key[2]!.trim().replace(/^["']|["']$/g, '');
		if (key[1] === 'user' && value) current.login = value;
		if (key[1] === 'token' && value) current.hasToken = true;
	}
	return hosts;
}

/**
 * `tea`'s config.yml: a `logins:` list.
 *
 *   logins:
 *   - name: work
 *     url: https://git.example.com
 *     token: …
 *     user: octocat
 */
export function parseTeaLogins(text: string): { url: string; host: string; login: string | null; token: string | null }[] {
	const logins: { url: string; host: string; login: string | null; token: string | null }[] = [];
	let inLogins = false;
	let current: Record<string, string> | null = null;
	const flush = () => {
		if (!current?.url) return;
		let host = '';
		try {
			host = new URL(current.url).hostname.toLowerCase();
		} catch {
			return;
		}
		logins.push({ url: current.url.replace(/\/+$/, ''), host, login: current.user || null, token: current.token || null });
	};
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '');
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const indent = line.length - line.trimStart().length;
		if (indent === 0 && !line.startsWith('-')) {
			if (inLogins) flush();
			inLogins = /^logins:\s*$/.test(line);
			current = null;
			continue;
		}
		if (!inLogins) continue;
		const item = /^\s*-\s*(.*)$/.exec(line);
		let body = line.trim();
		if (item) {
			flush();
			current = {};
			body = item[1]!.trim();
			if (!body) continue;
		}
		const pair = /^([\w-]+):\s*(.*)$/.exec(body);
		if (pair && current) current[pair[1]!] = pair[2]!.trim().replace(/^["']|["']$/g, '');
	}
	if (inLogins) flush();
	return logins;
}

function ghConfigDir(): string {
	if (process.env.GH_CONFIG_DIR?.trim()) return process.env.GH_CONFIG_DIR.trim();
	if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'GitHub CLI');
	return join(configHome(), 'gh');
}

function glabConfigPath(): string {
	if (process.env.GLAB_CONFIG_DIR?.trim()) return join(process.env.GLAB_CONFIG_DIR.trim(), 'config.yml');
	return join(configHome(), 'glab-cli', 'config.yml');
}

function teaConfigPath(): string {
	return join(configHome(), 'tea', 'config.yml');
}

// ---------------------------------------------------------------------------
// Reading a token
// ---------------------------------------------------------------------------

/**
 * The token a CLI holds for `host`, asked fresh.
 *
 * `gh auth token` and `glab config get token` both resolve the system keyring
 * when the CLI stores the token there, which reading the config file would
 * miss. `tea` has no such command and keeps the token in its file.
 */
export async function readCliToken(tool: CliTool, host: string): Promise<string | null> {
	if (tool === 'gh') {
		const result = await run('gh', ['auth', 'token', '--hostname', host]);
		const token = result?.code === 0 ? result.stdout.trim() : '';
		return token || null;
	}
	if (tool === 'glab') {
		const result = await run('glab', ['config', 'get', 'token', '--host', host]);
		const token = result?.code === 0 ? result.stdout.trim() : '';
		return token || null;
	}
	const text = readText(teaConfigPath());
	if (!text) return null;
	return parseTeaLogins(text).find((login) => login.host === host)?.token ?? null;
}

/** What a CLI reports for one host, without the token. */
async function describeCli(tool: CliTool, host: string): Promise<DetectedCredential | null> {
	if (tool === 'gh') {
		if (!Bun.which('gh')) return null;
		const text = readText(join(ghConfigDir(), 'hosts.yml'));
		const entry = text ? parseGhHosts(text).find((candidate) => candidate.host === host) : undefined;
		const token = await readCliToken('gh', host);
		if (!entry && !token) return null;
		return { source: 'gh', host, login: entry?.login ?? null, hasToken: !!token, canLink: true };
	}
	if (tool === 'glab') {
		if (!Bun.which('glab')) return null;
		const text = readText(glabConfigPath());
		const entry = text ? parseGlabHosts(text).find((candidate) => candidate.host === host) : undefined;
		const token = await readCliToken('glab', host);
		if (!entry && !token) return null;
		return { source: 'glab', host, login: entry?.login ?? null, hasToken: !!token, canLink: true };
	}
	const text = readText(teaConfigPath());
	const entry = text ? parseTeaLogins(text).find((login) => login.host === host) : undefined;
	if (!entry) return null;
	return { source: 'tea', host, login: entry.login, hasToken: !!entry.token, canLink: true };
}

/**
 * Every host a provider's CLI is signed in to — for the dialog that opens
 * before a server URL is known, so "gh is signed in to ghe.acme.com" can be
 * offered without the user typing it.
 */
export async function detectCliLogins(provider: GitHostKind, host: string | null): Promise<DetectedCredential[]> {
	const tool = cliForProvider(provider);
	if (!tool) return [];

	if (host) {
		const one = await describeCli(tool, host);
		return one ? [one] : [];
	}

	let hosts: string[] = [];
	if (tool === 'gh') {
		const text = readText(join(ghConfigDir(), 'hosts.yml'));
		hosts = text ? parseGhHosts(text).map((entry) => entry.host) : [];
	} else if (tool === 'glab') {
		const text = readText(glabConfigPath());
		hosts = text ? parseGlabHosts(text).map((entry) => entry.host) : [];
	} else {
		const text = readText(teaConfigPath());
		hosts = text ? parseTeaLogins(text).map((entry) => entry.host) : [];
	}

	const found = await Promise.all([...new Set(hosts)].map((candidate) => describeCli(tool, candidate)));
	return found.filter((entry): entry is DetectedCredential => entry !== null);
}

/** The URL `tea` has for a host, which carries any sub-path the server lives under. */
export function teaServerUrl(host: string): string | null {
	const text = readText(teaConfigPath());
	if (!text) return null;
	return parseTeaLogins(text).find((login) => login.host === host)?.url ?? null;
}

// ---------------------------------------------------------------------------
// git's credential store
// ---------------------------------------------------------------------------

/**
 * Ask git's configured credential helpers for `host`.
 *
 * This is what `git push` itself would use — osxkeychain, libsecret, Git
 * Credential Manager. Prompts are disabled so a helper with nothing stored
 * answers "nothing" instead of opening a dialog; a keychain that wants the
 * user to approve access may still ask the OS, which is why this only runs on
 * an explicit click.
 */
export async function readKeychain(host: string): Promise<{ username: string; password: string } | null> {
	const result = await run('git', ['credential', 'fill'], `protocol=https\nhost=${host}\n\n`);
	if (!result || result.code !== 0) return null;
	const fields: Record<string, string> = {};
	for (const line of result.stdout.split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1).trim();
	}
	if (!fields.password) return null;
	return { username: fields.username ?? '', password: fields.password };
}
