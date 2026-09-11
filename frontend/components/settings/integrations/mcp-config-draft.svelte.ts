/**
 * The working draft behind every MCP credential form.
 *
 * Install, Configure and Add-manually all edit the same thing — a set of
 * labelled fields plus any extra env vars or headers the user adds — so they
 * share one draft object rather than three copies of the same nine `$state`
 * declarations. Each dialog owns its own instance; nothing is global.
 */

import type { McpConfigField, McpTransport } from '$frontend/stores/features/mcp-servers.svelte';

export interface CustomRow {
	key: string;
	value: string;
}

export class McpConfigDraft {
	/** Drives which sections show: env for stdio, headers for remote. */
	transport = $state<McpTransport>('stdio');
	/** Registry-declared fields, which keep their labels and required markers. */
	fields = $state<McpConfigField[]>([]);
	/** Field name → value. */
	values = $state<Record<string, string>>({});
	/** User-added env vars, distinct from the declared ones. */
	customEnv = $state<CustomRow[]>([]);
	customHeader = $state<CustomRow[]>([]);
	command = $state('');
	/** One argument per line, in order. */
	argsText = $state('');
	url = $state('');
	name = $state('');

	readonly envFields = $derived(this.fields.filter((field) => field.kind === 'env'));
	readonly headerFields = $derived(this.fields.filter((field) => field.kind === 'header'));
	readonly missingRequired = $derived(
		this.fields.filter((field) => field.isRequired && !(this.values[field.name] ?? '').trim())
	);

	// stdio servers use env vars; remote servers use headers. Show the relevant
	// section, plus whichever the registry happens to declare for the other kind.
	readonly showEnvSection = $derived(this.transport === 'stdio' || this.envFields.length > 0);
	readonly showHeaderSection = $derived(this.transport !== 'stdio' || this.headerFields.length > 0);

	reset(): void {
		this.fields = [];
		this.values = {};
		this.customEnv = [];
		this.customHeader = [];
		this.command = '';
		this.argsText = '';
		this.url = '';
		this.name = '';
	}

	/**
	 * Split the draft back into the env and header maps engines read.
	 * Blank fields are dropped: an empty value means "not set", not "set to ''".
	 */
	collect(): { env: Record<string, string>; headers: Record<string, string> } {
		const env: Record<string, string> = {};
		const headers: Record<string, string> = {};

		for (const field of this.fields) {
			const value = (this.values[field.name] ?? '').trim();
			if (!value) continue;
			if (field.kind === 'header') headers[field.name] = value;
			else env[field.name] = value;
		}
		for (const row of this.customEnv) {
			const key = row.key.trim();
			if (key && row.value.trim()) env[key] = row.value;
		}
		for (const row of this.customHeader) {
			const key = row.key.trim();
			if (key && row.value.trim()) headers[key] = row.value;
		}
		return { env, headers };
	}

	/**
	 * Write one declared field.
	 *
	 * A setter rather than `bind:value={draft.values[name]}` at the call site.
	 * Binding reads the key BEFORE it exists whenever `fields` and `values` are
	 * populated after the first render, and Svelte rejects that outright
	 * (`props_invalid_value`) rather than treating it as empty. The invariant
	 * "fields and values are always assigned together" held here, but it is an
	 * invariant three dialogs have to remember — this removes the need to.
	 */
	setValue(field: string, value: string): void {
		this.values = { ...this.values, [field]: value };
	}

	args(): string[] {
		return this.argsText.split('\n').map((arg) => arg.trim()).filter(Boolean);
	}

	addCustomEnv(): void {
		this.customEnv = [...this.customEnv, { key: '', value: '' }];
	}

	removeCustomEnv(index: number): void {
		this.customEnv = this.customEnv.filter((_, i) => i !== index);
	}

	addCustomHeader(): void {
		this.customHeader = [...this.customHeader, { key: '', value: '' }];
	}

	removeCustomHeader(index: number): void {
		this.customHeader = this.customHeader.filter((_, i) => i !== index);
	}
}

/** `stdio` / `http` / `sse` as the UI names them. */
export function transportLabel(transport: string): string {
	if (transport === 'stdio') return 'local (stdio)';
	if (transport === 'sse') return 'remote (sse)';
	return 'remote (http)';
}

/** The command line or URL a server actually runs, for the one-line summary. */
export function commandLine(
	server: { transport: string; command?: string | null; args?: string[]; url?: string | null }
): string {
	if (server.transport === 'stdio') return `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim();
	return server.url ?? '';
}
