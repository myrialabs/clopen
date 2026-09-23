/**
 * The two helper subcommands git invokes: `git-credential` and `git-askpass`.
 *
 * Both exist for one reason: A SECRET MUST NOT TRAVEL THROUGH ARGV OR THE
 * ENVIRONMENT. `ps` shows another user on the same machine every argument of
 * every running process, and the alternatives git offers all leak:
 * `http.extraheader` puts the token in the command line, `credential.helper
 * store` writes it to a plaintext file, and a token embedded in a remote URL
 * persists in `.git/config`. A helper receives its question on stdin and
 * answers on stdout, which no other process can read.
 *
 * ── STDOUT IS THE PROTOCOL ──
 * Git parses this process's stdout. Anything else written there — a debug line,
 * a warning, a stray `console.log` from a module loaded on the way in — is read
 * as part of the answer and corrupts it. So the first thing either entry point
 * does is move `console.log` to stderr. That is not tidiness; it is what keeps
 * an unrelated log statement from breaking authentication.
 *
 * These run in a SHORT-LIVED SEPARATE PROCESS. Git spawns them, they answer,
 * they exit. They open the database directly and start no server.
 */

/**
 * Silence routine logging for the rest of this process.
 *
 * `debug.log` writes through `console.log`, which is stdout — the protocol
 * channel. Redirecting it to stderr protects the protocol but then prints
 * "Connected to database" into the middle of the user's `git push` output,
 * which is noise they can neither act on nor turn off. So routine logs are
 * dropped entirely; a genuine helper failure still goes to stderr through
 * `console.error`, which git shows and which is worth showing.
 */
function protectStdout(): void {
	const drop = () => {};
	console.log = drop;
	console.info = drop;
	console.debug = drop;
}

/** `--identity=<id>` out of the helper's own arguments. */
export function identityIdFrom(argv: string[]): string | null {
	for (const arg of argv) {
		if (arg.startsWith('--identity=')) {
			const value = arg.slice('--identity='.length).trim();
			if (value) return value;
		}
	}
	return null;
}

/**
 * Open the existing database, without migrating or seeding it.
 *
 * `initializeDatabase()` would run migrations and seeders — the right thing for
 * a server starting up, the wrong thing for a helper git spawned mid-push. It
 * would race the running server's schema and could apply a migration from a
 * process nobody is watching. A helper only ever reads one row.
 */
async function connectReadOnly(): Promise<void> {
	const { connectExistingDatabase } = await import('$backend/database');
	await connectExistingDatabase();
}

/** Read stdin to the end. Empty string when nothing is piped. */
async function readStdin(): Promise<string> {
	try {
		return await new Response(Bun.stdin.stream()).text();
	} catch {
		return '';
	}
}

/**
 * Parse git's credential description: `key=value` lines, blank line terminated.
 *
 * Unknown keys are kept — git adds fields over time, and one we do not
 * recognise is not a reason to fail an authentication.
 */
export function parseCredentialRequest(input: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of input.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf('=');
		if (eq <= 0) continue;
		fields[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
	}
	return fields;
}

/**
 * Answer a `git credential` request.
 *
 * Only `get` produces output. `store` and `erase` are accepted and ignored on
 * purpose: the credential lives in Clopen's database, and letting git overwrite
 * or delete it would put git's cache in charge of a user's stored account.
 * Exiting 0 without output tells git "no opinion", which is the correct answer
 * for a read-only helper.
 */
async function runCredentialHelper(argv: string[]): Promise<number> {
	const operation = argv.find((a) => !a.startsWith('--')) ?? 'get';
	if (operation !== 'get') return 0;

	const identityId = identityIdFrom(argv);
	if (!identityId) return 0;

	const request = parseCredentialRequest(await readStdin());

	// Imported here, after stdout is protected, and lazily so `store`/`erase`
	// never pay for opening the database.
	await connectReadOnly();
	const { gitIdentityQueries, integrationAccountQueries, parseHosts } = await import(
		'$backend/database/queries'
	);

	const row = gitIdentityQueries.getById(identityId);
	if (!row) return 0;

	// The host git is asking about must be one this identity claims. Without the
	// check, a repository whose remote was changed to another host would be
	// handed this account's token.
	const host = (request.host ?? '').toLowerCase().split(':')[0] ?? '';
	if (host && !parseHosts(row.hosts).includes(host)) return 0;

	let token: string | null = null;
	if (row.auth_method === 'https-token') {
		token = row.https_token;
	} else if (row.auth_method === 'https-account' && row.integration_account_id) {
		// Borrowed from a connected integration account, so rotating the token in
		// one place is enough.
		const account = integrationAccountQueries.getById(row.integration_account_id);
		if (account) {
			const credentials = integrationAccountQueries.credentialsOf(account);
			token = credentials.token ?? credentials.apiKey ?? null;
		}
	}
	if (!token) return 0;

	// GitHub and friends accept any non-empty username alongside a token, but it
	// must not be blank, so fall back to the conventional placeholder.
	const username = row.https_username || request.username || 'x-access-token';
	process.stdout.write(`username=${username}\npassword=${token}\n`);
	return 0;
}

/**
 * Answer `ssh`'s passphrase prompt.
 *
 * `ssh` calls SSH_ASKPASS with the prompt text as an argument and reads the
 * answer from stdout. Only passphrase prompts are answered: a host-key
 * confirmation ("Are you sure you want to continue connecting?") reaching this
 * helper must not be auto-accepted, because that is the check that detects a
 * man-in-the-middle.
 */
async function runAskpass(argv: string[]): Promise<number> {
	const identityId = identityIdFrom(argv);
	if (!identityId) return 1;

	const prompt = argv.filter((a) => !a.startsWith('--') && a !== 'git-askpass').join(' ');
	if (prompt && !/passphrase|password/i.test(prompt)) {
		// Declining leaves ssh to fail the way it would without us, which is the
		// safe outcome for anything that is not a passphrase question.
		return 1;
	}

	await connectReadOnly();
	const { gitIdentityQueries } = await import('$backend/database/queries');

	const row = gitIdentityQueries.getById(identityId);
	if (!row?.ssh_passphrase) return 1;

	process.stdout.write(`${row.ssh_passphrase}\n`);
	return 0;
}

/** The subcommands this module owns. */
export const GIT_HELPER_COMMANDS = ['git-credential', 'git-askpass'] as const;

/**
 * Handle a helper subcommand if this invocation is one.
 *
 * Returns the exit code to use, or `null` when the arguments are not a helper
 * call and the CLI should carry on to its normal startup.
 */
export async function runGitHelper(argv: string[]): Promise<number | null> {
	const command = argv[0];
	if (command !== 'git-credential' && command !== 'git-askpass') return null;

	protectStdout();

	try {
		return command === 'git-credential'
			? await runCredentialHelper(argv.slice(1))
			: await runAskpass(argv.slice(1));
	} catch (error) {
		// Never print the failure to stdout, and never expose the reason to git —
		// an empty answer means "no credential", which is what a failure is.
		console.error('[clopen] git helper failed:', error);
		return command === 'git-credential' ? 0 : 1;
	}
}
