/**
 * ssh-client — turning a saved connection into a live `ssh2.Client`.
 *
 * One place builds the ssh2 `ConnectConfig` for all four auth methods, walks
 * the ProxyJump chain, and runs the host-key check, so the terminal, SFTP,
 * port forwarding and the db-client tunnel all authenticate identically.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { Client as SshClient, type ConnectConfig } from 'ssh2';
import { sshConnectionQueries } from '../database/queries';
import { evaluateHostKey, hostKeyChangedMessage, type HostKeyVerdict } from './known-hosts';
import type { SshConnection } from '$shared/types/ssh';
import { debug } from '$shared/utils/logger';

/**
 * Raised when the host presented a key that differs from the trusted one. Typed
 * so callers can report *why* the dial failed — Test shows a "trust new key"
 * action instead of a generic connection error.
 */
export class HostKeyChangedError extends Error {
	constructor(
		message: string,
		readonly verdict: Extract<HostKeyVerdict, { outcome: 'changed' }>
	) {
		super(message);
		this.name = 'HostKeyChangedError';
	}
}

/** Guards a malformed jump chain that slipped past the save-time cycle check. */
const MAX_JUMP_DEPTH = 8;

const HANDSHAKE_TIMEOUT_MS = 20_000;

export interface DialResult {
	client: SshClient;
	/** What the host-key check concluded — surfaced in Test and in the terminal. */
	hostKey: HostKeyVerdict;
	/** The remote SSH identification string, when ssh2 reported one. */
	serverBanner: string | null;
	/** Every client opened for this dial, outermost host last. Close in reverse. */
	chain: SshClient[];
}

function expandHome(path: string): string {
	if (path === '~') return homedir();
	if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(path);
}

async function readPrivateKeyFile(path: string): Promise<Buffer> {
	try {
		return await readFile(expandHome(path));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read private key at ${path}: ${reason}`);
	}
}

/**
 * The agent socket to hand ssh2. Windows has no unix socket for this — Pageant
 * is addressed by the literal string 'pageant', which ssh2 special-cases.
 */
function resolveAgentSocket(connection: SshConnection): string {
	if (connection.agentSocket) return expandHome(connection.agentSocket);
	if (process.platform === 'win32') return 'pageant';
	const fromEnv = process.env.SSH_AUTH_SOCK;
	if (!fromEnv) {
		throw new Error('No ssh-agent found — SSH_AUTH_SOCK is not set on the Clopen server');
	}
	return fromEnv;
}

async function applyAuth(connection: SshConnection, config: ConnectConfig): Promise<void> {
	switch (connection.authMethod) {
		case 'password': {
			if (!connection.password) throw new Error('Password auth needs a password');
			config.password = connection.password;
			// Many hardened hosts turn off `PasswordAuthentication` but keep
			// `KbdInteractiveAuthentication`, which is the same secret over a
			// different exchange. Offer both rather than failing on the first.
			config.tryKeyboard = true;
			break;
		}
		case 'key': {
			if (!connection.privateKey) throw new Error('Key auth needs a private key');
			config.privateKey = connection.privateKey;
			if (connection.passphrase) config.passphrase = connection.passphrase;
			break;
		}
		case 'key-file': {
			if (!connection.privateKeyPath) throw new Error('Key-file auth needs a key path');
			config.privateKey = await readPrivateKeyFile(connection.privateKeyPath);
			if (connection.passphrase) config.passphrase = connection.passphrase;
			break;
		}
		case 'agent': {
			config.agent = resolveAgentSocket(connection);
			break;
		}
		default: {
			const exhaustive: never = connection.authMethod;
			throw new Error(`Unsupported SSH auth method: ${exhaustive}`);
		}
	}
}

interface HandshakeOutcome {
	hostKey: HostKeyVerdict | null;
	serverBanner: string | null;
}

/**
 * Connect one hop. `sock` carries the stream from the previous hop when this
 * host is reached through a bastion.
 */
async function connectOne(
	connection: SshConnection,
	sock?: NodeJS.ReadableStream
): Promise<{ client: SshClient; outcome: HandshakeOutcome }> {
	const config: ConnectConfig = {
		host: connection.host,
		port: connection.port || 22,
		username: connection.username,
		readyTimeout: HANDSHAKE_TIMEOUT_MS,
		keepaliveInterval: Math.max(0, connection.keepaliveSeconds) * 1000
	};

	if (sock) config.sock = sock as ConnectConfig['sock'];

	await applyAuth(connection, config);

	const outcome: HandshakeOutcome = { hostKey: null, serverBanner: null };

	// ssh2 exposes the remote identification string only through its debug sink.
	// It is display-only (shown as the server banner in Test), so reading it here
	// costs nothing and keeps the rest of the module off ssh2's internals.
	config.debug = (message: string): void => {
		const match = /^Remote ident: '(.+)'$/.exec(message);
		if (match) outcome.serverBanner = match[1];
	};

	config.hostVerifier = (keyBlob: Buffer): boolean => {
		const verdict = evaluateHostKey(
			connection.host,
			connection.port || 22,
			keyBlob,
			connection.strictHostKey
		);
		outcome.hostKey = verdict;
		return verdict.outcome !== 'changed';
	};

	const client = new SshClient();

	if (connection.authMethod === 'password' && connection.password) {
		const password = connection.password;
		client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
			// Answer every prompt with the stored password; a host that asks for
			// more than that (a real second factor) will simply reject it.
			finish(prompts.map(() => password));
		});
	}

	await new Promise<void>((resolvePromise, rejectPromise) => {
		const onReady = (): void => {
			client.removeListener('error', onError);
			resolvePromise();
		};
		const onError = (error: Error): void => {
			client.removeListener('ready', onReady);
			// ssh2 reports a rejected host key as a generic handshake failure.
			// Replace it with the message that says what actually happened.
			if (outcome.hostKey?.outcome === 'changed') {
				const changed = outcome.hostKey;
				rejectPromise(
					new HostKeyChangedError(
						hostKeyChangedMessage(connection.host, connection.port || 22, changed),
						changed
					)
				);
				return;
			}
			rejectPromise(error);
		};
		client.once('ready', onReady);
		client.once('error', onError);
		try {
			client.connect(config);
		} catch (error) {
			rejectPromise(error instanceof Error ? error : new Error(String(error)));
		}
	});

	return { client, outcome };
}

/** Open the stream that reaches `target` from an already-connected bastion. */
function openJumpChannel(
	bastion: SshClient,
	targetHost: string,
	targetPort: number
): Promise<NodeJS.ReadableStream> {
	return new Promise((resolvePromise, rejectPromise) => {
		bastion.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, stream) => {
			if (error) {
				rejectPromise(new Error(`Jump host could not reach ${targetHost}:${targetPort} — ${error.message}`));
				return;
			}
			resolvePromise(stream);
		});
	});
}

/** Resolve the saved hosts to hop through, bastion-first. */
function resolveJumpChain(connection: SshConnection): SshConnection[] {
	const chain: SshConnection[] = [];
	let cursor = connection.jumpConnectionId;
	const visited = new Set<string>([connection.id]);
	while (cursor) {
		if (visited.has(cursor)) {
			throw new Error('The jump host chain loops back on itself');
		}
		visited.add(cursor);
		const hop = sshConnectionQueries.get(cursor);
		if (!hop) throw new Error('A jump host in this chain no longer exists');
		chain.unshift(hop);
		if (chain.length > MAX_JUMP_DEPTH) {
			throw new Error(`Jump host chain is deeper than ${MAX_JUMP_DEPTH} hops`);
		}
		cursor = hop.jumpConnectionId;
	}
	return chain;
}

/** Close a dial's clients, innermost hop first. Never throws. */
export function closeChain(chain: SshClient[]): void {
	for (const client of [...chain].reverse()) {
		try {
			client.end();
		} catch {
			// Already gone — nothing to do.
		}
	}
}

/**
 * Connect to `connection`, hopping through its jump chain if it has one.
 * Every client opened along the way is returned so the caller can close them
 * all; on failure they are closed here.
 */
export async function dial(connection: SshConnection): Promise<DialResult> {
	const hops = resolveJumpChain(connection);
	const chain: SshClient[] = [];

	try {
		let sock: NodeJS.ReadableStream | undefined;

		// Each hop opens a channel to the next one, and the last opens a channel to
		// the destination itself — so the chain arrives as a single stream.
		for (const [index, hop] of hops.entries()) {
			const { client } = await connectOne(hop, sock);
			chain.push(client);
			const following = hops[index + 1];
			const destinationHost = following ? following.host : connection.host;
			const destinationPort = following ? following.port || 22 : connection.port || 22;
			sock = await openJumpChannel(client, destinationHost, destinationPort);
		}

		const { client, outcome } = await connectOne(connection, sock);
		chain.push(client);

		if (!outcome.hostKey) {
			throw new Error('The host key check did not run — refusing the connection');
		}

		debug.log(
			'ssh',
			`connected ${connection.username}@${connection.host}:${connection.port || 22}` +
				(hops.length > 0 ? ` via ${hops.length} jump host(s)` : '')
		);

		return {
			client,
			hostKey: outcome.hostKey,
			serverBanner: outcome.serverBanner,
			chain
		};
	} catch (error) {
		closeChain(chain);
		throw error;
	}
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	/** The remote exit status. 0 means success. */
	code: number;
}

/**
 * Run a short command over an exec channel and collect its output. Never
 * throws on a non-zero exit — the caller decides whether that is a failure,
 * because several probes treat "command not found" as simply "not this host".
 */
export function runCommandDetailed(
	client: SshClient,
	command: string,
	timeoutMs = 15_000
): Promise<CommandResult> {
	return new Promise((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => rejectPromise(new Error(`Command timed out: ${command}`)), timeoutMs);
		client.exec(command, (error, stream) => {
			if (error) {
				clearTimeout(timer);
				rejectPromise(error);
				return;
			}
			let stdout = '';
			let stderr = '';
			let code = 0;
			stream.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf8');
			});
			stream.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf8');
			});
			stream.on('exit', (exitCode: number | null) => {
				if (typeof exitCode === 'number') code = exitCode;
			});
			stream.on('close', () => {
				clearTimeout(timer);
				resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim(), code });
			});
			stream.on('error', (streamError: Error) => {
				clearTimeout(timer);
				rejectPromise(streamError);
			});
		});
	});
}

/** Run a short command and return its stdout. Used for the remote OS probe. */
export async function runCommand(client: SshClient, command: string, timeoutMs = 5_000): Promise<string> {
	const result = await runCommandDetailed(client, command, timeoutMs);
	return result.stdout;
}

/**
 * Run a command and throw if it failed. The thrown message carries the remote
 * stderr, which is what actually tells the user why (permission denied, no such
 * file, `zip` not installed).
 */
export async function runCommandOrThrow(
	client: SshClient,
	command: string,
	whatItWasDoing: string,
	timeoutMs = 60_000
): Promise<string> {
	const result = await runCommandDetailed(client, command, timeoutMs);
	if (result.code !== 0) {
		const reason = result.stderr || result.stdout || `exit status ${result.code}`;
		throw new Error(`${whatItWasDoing}: ${reason}`);
	}
	return result.stdout;
}

/** Single-quote a POSIX shell argument, escaping any embedded quote. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
