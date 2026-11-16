/**
 * A password typed into a chat does not stay in the chat.
 *
 * When the owner gives Clopen a password or key in plain words and Clopen
 * saves it to the vault, the value is replaced in that chat's history (and
 * the journal) and the owner's own message is deleted from the chat app it
 * came through. From then on it exists only in the encrypted vault.
 *
 * And a saved secret never goes back through a model: commands and pages get
 * it by name (`{{secret:name}}`, a browser `type` with `secret`), and every
 * tool report is masked before a model reads it.
 */

import { getDatabase } from '$backend/database';
import { channelLinkQueries, channelMessageQueries, secretQueries, settingsQueries } from '$backend/database/queries';
import { debug } from '$shared/utils/logger';

const MASK = '••••••';

export async function scrubSecretFromChat(sessionId: string | null | undefined, value: string): Promise<number> {
	if (!sessionId || value.length < 6) return 0;
	const db = getDatabase();
	const needle = JSON.stringify(value).slice(1, -1);
	const rows = db.prepare('SELECT id, data FROM messages WHERE session_id = ? AND instr(data, ?) > 0').all(sessionId, needle) as Array<{ id: string; data: string }>;
	const update = db.prepare('UPDATE messages SET data = ? WHERE id = ?');
	for (const row of rows) update.run(row.data.split(needle).join(MASK), row.id);
	try {
		// The search index keeps its own copy of the text.
		const fts = db.prepare('UPDATE messages_fts SET text = replace(text, ?, ?) WHERE message_id = ?');
		for (const row of rows) fts.run(value, MASK, row.id);
	} catch (error) {
		debug.warn('assistant', 'Scrubbing the search index failed:', error);
	}
	try {
		db.prepare('UPDATE journal_entries SET text = replace(text, ?, ?) WHERE instr(text, ?) > 0').run(value, MASK, value);
	} catch (error) {
		debug.warn('assistant', 'Scrubbing the journal failed:', error);
	}

	// The owner's message in the chat app it came from.
	const ids = new Set(rows.map((row) => row.id));
	const sent = channelMessageQueries.userMessagesForSession(sessionId).filter((row) => row.clopen_message_id && ids.has(row.clopen_message_id));
	if (sent.length) {
		const { channelRuntime } = await import('$backend/chat-apps/runtime');
		for (const row of sent) {
			const link = channelLinkQueries.getById(row.link_id);
			if (link) await channelRuntime.deleteMessage(link.account_id, link.conversation_id, row.platform_message_id);
		}
	}
	return rows.length;
}

// ── Secrets the model never sees ────────────────────────────────────────────

let known: { at: number; values: Array<{ name: string; value: string }> } | null = null;

/** The vault's values, decrypted for a few seconds at a time. */
function secretValues(): Array<{ name: string; value: string }> {
	if (known && Date.now() - known.at < 10_000) return known.values;
	const values = secretQueries
		.list()
		.map((secret) => ({ name: secret.name, value: secretQueries.reveal(secret.name) ?? '' }))
		.filter((entry) => entry.value.length >= 6);
	known = { at: Date.now(), values };
	return values;
}

/** Forget the cached values (a secret was saved or deleted). */
export function forgetSecretValues(): void {
	known = null;
}

/**
 * Hide every saved secret in text a model is about to read — a tool's
 * report, a command's output. A field read back after typing, a page that
 * shows the key, a command that echoes it: none of it reaches the model.
 */
export function maskSecrets(text: string): string {
	if (!text) return text;
	let out = text;
	for (const { value } of secretValues()) {
		for (const needle of new Set([value, JSON.stringify(value).slice(1, -1)])) {
			if (out.includes(needle)) out = out.split(needle).join(MASK);
		}
	}
	return out;
}

/**
 * Put saved secrets where a command or request names them — `{{secret:name}}`
 * — at the last moment, on this machine. The model writes the name; the value
 * goes straight to the program.
 */
export function fillSecretRefs(text: string): string {
	return text.replace(/\{\{\s*secret:\s*([\w.-]+)\s*\}\}/g, (match, name: string) => {
		const value = secretQueries.reveal(name);
		if (value === null) throw new Error(`There is no secret "${name}". Ask the owner for it once and save it with secret.save.`);
		return value;
	});
}

/**
 * Once: take every saved secret out of the history it already reached —
 * before secrets were typed by name, a password went through the model and
 * stayed in the messages (and the search index, and the journal).
 */
export async function scrubKnownSecretsOnce(): Promise<void> {
	const FLAG = 'assistant:secrets-scrubbed';
	if (settingsQueries.get(FLAG)?.value === '1') return;
	const secrets = secretValues();
	if (!secrets.length) {
		settingsQueries.set(FLAG, '1');
		return;
	}
	const db = getDatabase();
	const needles = [...new Set(secrets.flatMap(({ value }) => [value, JSON.stringify(value).slice(1, -1)]))];
	const { last } = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS last FROM messages').get() as { last: number };
	// In slices, yielding between them: the history can be gigabytes, and the server keeps serving meanwhile.
	const SLICE = 5_000;
	const update = db.prepare('UPDATE messages SET data = replace(data, ?, ?) WHERE rowid > ? AND rowid <= ? AND instr(data, ?) > 0');
	let changed = 0;
	for (let from = 0; from < last; from += SLICE) {
		for (const needle of needles) changed += Number((update.run(needle, MASK, from, from + SLICE, needle) as { changes?: number }).changes ?? 0);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	for (const needle of needles) {
		try {
			db.prepare('UPDATE messages_fts SET text = replace(text, ?, ?) WHERE instr(text, ?) > 0').run(needle, MASK, needle);
		} catch {
			// No search index on this install.
		}
		db.prepare('UPDATE journal_entries SET text = replace(text, ?, ?) WHERE instr(text, ?) > 0').run(needle, MASK, needle);
	}
	settingsQueries.set(FLAG, '1');
	debug.log('assistant', `Saved secrets taken out of history (${changed} message(s))`);
}
