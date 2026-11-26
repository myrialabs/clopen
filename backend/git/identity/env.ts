/**
 * Turning an identity into environment variables git obeys.
 *
 * Git reads `GIT_CONFIG_COUNT` plus `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 * as if each pair had been passed as `-c key=value` (git 2.31+). That is the
 * whole mechanism, and it was chosen over the two alternatives for reasons that
 * are worth keeping written down:
 *
 *  - Writing `user.name` into the repository's `.git/config` would cover every
 *    git invocation, including ones Clopen never sees — but it MODIFIES THE
 *    USER'S REPOSITORY, is visible to their own CLI outside Clopen, and two
 *    Clopen users sharing a checkout would overwrite each other.
 *  - Passing `-c` on the command line only reaches commands Clopen spawns
 *    itself, so an agent running `git commit` through its shell tool would
 *    still use the machine's identity.
 *
 * Environment variables are inherited, so one builder covers all three
 * surfaces: Clopen's own git calls, the engine process, and the terminal PTY.
 * The repository is never touched.
 *
 * ── What is deliberately NOT here ──
 * No secret is ever placed in a variable or an argument. The HTTPS token is
 * fetched by a credential helper over its own stdin/stdout protocol, and the
 * SSH passphrase by an askpass helper, precisely because argv is world-readable
 * through `ps` and the environment of a process is readable by its owner.
 */

import { debug } from '$shared/utils/logger';

/** An identity reduced to what the env builder needs. */
export interface GitEnvIdentity {
	id: string;
	name: string;
	email: string;
	/** Absolute path to the materialised private key, when one is stored. */
	sshKeyPath?: string | null;
	/** True when that key needs a passphrase — turns on the askpass helper. */
	needsPassphrase?: boolean;
	/** Host → username for the credential protocol, when HTTPS auth is used. */
	httpsUsername?: string | null;
	/** Hosts the credential helper should answer for. */
	credentialHosts?: string[];
}

/** How to re-invoke Clopen for the credential/askpass helpers. */
export interface HelperCommand {
	/** The runtime executable (`process.execPath`). */
	runtime: string;
	/** The entry script (`Bun.main`). */
	script: string;
	/**
	 * The data directory of the Clopen that wrote this command.
	 *
	 * Git runs the helper as a brand-new process with the environment Clopen
	 * spawned git with — and that environment is deliberately cleaned of
	 * `NODE_ENV`. Without the directory pinned here, a helper started for a
	 * development instance (`~/.clopen-dev`) or one with `CLOPEN_DATA_DIR` set
	 * opened the DEFAULT database, found no account, answered nothing, and git
	 * fell through to "could not read Username".
	 */
	dataDir?: string;
}

/**
 * The start of a helper command line: the data directory, then runtime and
 * script. Git runs `!`-helpers through a POSIX shell, so a leading
 * `NAME=value` sets the variable for that one command only.
 */
function helperInvocation(helper: HelperCommand): string {
	const parts = [shellQuote(helper.runtime), shellQuote(helper.script)];
	return helper.dataDir ? `CLOPEN_DATA_DIR=${shellQuote(helper.dataDir)} ${parts.join(' ')}` : parts.join(' ');
}

/**
 * Quote one argument for the shell git runs a `!`-prefixed helper through.
 *
 * Single quotes with the standard `'\''` escape: inside single quotes a POSIX
 * shell expands nothing, so a data directory containing a space, a `$`, or a
 * backtick cannot turn into a command. This runs on every git invocation, so
 * getting it wrong would be a command injection through a file path.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Config pairs for an identity, as `[key, value]` tuples. */
export function buildGitConfigPairs(
	identity: GitEnvIdentity,
	helper?: HelperCommand
): Array<[string, string]> {
	const pairs: Array<[string, string]> = [
		['user.name', identity.name],
		['user.email', identity.email]
	];

	if (identity.sshKeyPath) {
		// `IdentitiesOnly=yes` is not optional. Without it ssh still offers every
		// key the agent holds, in the agent's order, and a server that accepts one
		// of those authenticates as the WRONG ACCOUNT — with no error to notice,
		// because the push succeeds.
		const sshArgs = [
			'ssh',
			'-i',
			shellQuote(identity.sshKeyPath),
			'-o',
			'IdentitiesOnly=yes'
		];
		pairs.push(['core.sshCommand', sshArgs.join(' ')]);
	}

	if (helper && identity.credentialHosts?.length) {
		// `credential.helper` is a MULTI-VALUE key: git collects every configured
		// helper and asks them in order, first answer wins. The user's global
		// config almost always names one already (osxkeychain, libsecret,
		// manager), and it is consulted BEFORE a command-line value — so without
		// this reset, choosing the "Work" account and pushing would authenticate
		// with whatever token the system keychain volunteered. That is the exact
		// failure this feature exists to prevent, and it fails silently: the push
		// succeeds, under the wrong account.
		//
		// An empty value clears the accumulated list, so the next entry is the
		// only helper git will ask. Only done when this identity actually carries
		// an HTTPS credential — an attribution-only identity leaves the machine's
		// helpers exactly as they were.
		pairs.push(['credential.helper', '']);

		// The helper is asked for a credential, it is never handed one. Git runs
		// this through a shell (the `!` prefix), passes the request on stdin, and
		// reads the answer from stdout.
		const command = [
			helperInvocation(helper),
			'git-credential',
			shellQuote(`--identity=${identity.id}`)
		].join(' ');
		pairs.push(['credential.helper', `!${command}`]);

		for (const host of identity.credentialHosts) {
			// Scoping by host means a repo whose `origin` and `upstream` live on
			// different accounts asks the right helper for each.
			if (identity.httpsUsername) {
				pairs.push([`credential.https://${host}.username`, identity.httpsUsername]);
			}
		}
	}

	return pairs;
}

/**
 * Credential pairs for hosts served by a connected hosting account.
 *
 * Scoped per host (`credential.https://github.com.*`), so a host no account
 * serves keeps the machine's own helpers untouched. For a host that IS served,
 * the same reset-then-ours rule as above applies — otherwise the system
 * keychain would answer first with whatever account it happens to hold.
 *
 * `useHttpPath` makes git send the repository path to the helper. That is what
 * lets one helper choose between two accounts on the same host by the
 * repository's owner, the way the Git panel does.
 */
export function buildHostedCredentialPairs(
	hosts: string[],
	projectId: string,
	helper?: HelperCommand
): Array<[string, string]> {
	if (!helper || hosts.length === 0) return [];
	const command = [
		helperInvocation(helper),
		'git-credential',
		'--hosted',
		shellQuote(`--project=${projectId}`)
	].join(' ');

	const pairs: Array<[string, string]> = [];
	for (const host of [...new Set(hosts)].sort()) {
		pairs.push([`credential.https://${host}.helper`, '']);
		pairs.push([`credential.https://${host}.helper`, `!${command}`]);
		pairs.push([`credential.https://${host}.useHttpPath`, 'true']);
	}
	return pairs;
}

/**
 * The environment fragment for an identity, plus any hosted-credential pairs.
 *
 * Returns `{}` when there is neither, so every caller can merge
 * unconditionally and a project without them behaves exactly as Clopen did
 * before this feature.
 */
export function buildGitIdentityEnv(
	identity: GitEnvIdentity | null,
	helper?: HelperCommand,
	extraPairs: Array<[string, string]> = []
): Record<string, string> {
	if (!identity && extraPairs.length === 0) return {};

	const pairs = [...(identity ? buildGitConfigPairs(identity, helper) : []), ...extraPairs];
	const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };

	pairs.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});

	if (identity?.sshKeyPath && identity.needsPassphrase && helper) {
		// `ssh` only consults SSH_ASKPASS when it has no terminal to prompt on.
		// A PTY-backed shell HAS one, so without REQUIRE=force a passphrased key
		// would hang the terminal waiting for input git can never deliver.
		const askpass = [
			shellQuote(helper.runtime),
			shellQuote(helper.script),
			'git-askpass',
			shellQuote(`--identity=${identity.id}`)
		].join(' ');
		env.SSH_ASKPASS = askpass;
		// ssh runs the askpass program directly, not through a shell, so the
		// data directory travels as a variable rather than a command prefix.
		if (helper.dataDir) env.CLOPEN_DATA_DIR = helper.dataDir;
		env.SSH_ASKPASS_REQUIRE = 'force';
		// Older OpenSSH consults DISPLAY before SSH_ASKPASS. The value is never
		// connected to, it only has to be non-empty.
		env.DISPLAY = env.DISPLAY || ':0';
	}

	debug.log('git', `Git identity env built for ${identity?.email ?? 'hosted accounts only'} (${pairs.length} config pairs)`);
	return env;
}

/**
 * The hostname a git remote URL points at, lowercased.
 *
 * Handles the three shapes git accepts: scp-like (`git@github.com:owner/repo`),
 * a real URL (`https://github.com/owner/repo`, `ssh://git@host:22/repo`), and a
 * local path — which has no host and yields null.
 */
export function remoteHost(url: string): string | null {
	const trimmed = url.trim();
	if (!trimmed) return null;

	// scp-like syntax is not a URL and `new URL()` would misread it: the part
	// after the colon is a path, not a port.
	const scpLike = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)/.exec(trimmed);
	if (scpLike) return scpLike[1]!.toLowerCase();

	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === 'file:') return null;
		return parsed.hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}
