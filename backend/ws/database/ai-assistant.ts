/**
 * Database Manager - AI SQL Assistant Handler
 *
 * Uses the Anthropic Messages API directly (single API call, no agentic loop)
 * to generate SQL from natural language and explain queries in plain language.
 * Schema context contains only table names and column names — no row data.
 */

import { t } from 'elysia';
import Anthropic from '@anthropic-ai/sdk';
import { createRouter } from '$shared/utils/ws-server';
import { parseModelId } from '$shared/constants/engines';
import { assertCan } from '../../db-manager/rbac';
import { getDecryptedConnection } from './connections';
import { listTables, describeTable } from '../../db-manager';
import { engineQueries } from '../../database/queries/engine-queries';
import { debug } from '$shared/utils/logger';

// ─── Model ID mapping ─────────────────────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
	haiku: 'claude-haiku-4-5-20251001',
	sonnet: 'claude-sonnet-4-6',
	opus: 'claude-opus-4-6'
};

function resolveModelId(shortId: string): string {
	return MODEL_MAP[shortId] ?? shortId;
}

// ─── Anthropic client factory ─────────────────────────────────────────────────

function getAnthropicClient(): Anthropic {
	if (process.env.ANTHROPIC_API_KEY) {
		return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
	}
	const account = engineQueries.getActiveClaudeAccount();
	if (account?.oauth_token) {
		return new Anthropic({ authToken: account.oauth_token });
	}
	throw new Error('No Anthropic API key or active Claude account found. Please log in to Claude or set ANTHROPIC_API_KEY.');
}

// ─── Schema builder ───────────────────────────────────────────────────────────

/**
 * Fetches and formats the database schema as a compact string.
 * Only table names and column names — no row data.
 * Capped at 40 tables to keep context size reasonable.
 */
async function buildSchemaContext(connectionId: string, dbType: string): Promise<string> {
	const config = await getDecryptedConnection(connectionId);
	const tables = await listTables(config);
	const limited = tables.slice(0, 40);

	const columnResults = await Promise.allSettled(
		limited.map((tbl) => describeTable(config, tbl.name, tbl.schema))
	);

	const lines: string[] = [`Database type: ${dbType}`, 'Tables:'];
	limited.forEach((tbl, idx) => {
		const result = columnResults[idx];
		const prefix = tbl.schema ? `${tbl.schema}.` : '';
		if (result.status === 'fulfilled' && result.value.length) {
			const cols = result.value
				.map((col) => {
					let desc = `${col.name} ${col.type}`;
					if (col.primaryKey) desc += ' PK';
					if (!col.nullable) desc += ' NOT NULL';
					return desc;
				})
				.join(', ');
			lines.push(`  - ${prefix}${tbl.name} (${cols})`);
		} else {
			lines.push(`  - ${prefix}${tbl.name}`);
		}
	});

	return lines.join('\n');
}

// ─── JSON parser (tolerant) ───────────────────────────────────────────────────

function extractJson(text: string): unknown {
	// Try direct parse first
	try {
		return JSON.parse(text);
	} catch {
		// Extract JSON object from text (e.g. when model wraps in markdown)
		const match = text.match(/\{[\s\S]*\}/);
		if (match) {
			try {
				return JSON.parse(match[0]);
			} catch {
				// ignore
			}
		}
	}
	return null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const aiAssistantHandler = createRouter()

	// Generate SQL from natural language
	.http(
		'db:ai:generate-sql',
		{
			data: t.Object({
				connectionId: t.String(),
				prompt: t.String({ minLength: 1 }),
				engine: t.String(),
				model: t.String()
			}),
			response: t.Object({
				sql: t.String(),
				explanation: t.String()
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');

			const config = await getDecryptedConnection(data.connectionId);
			const schemaContext = await buildSchemaContext(data.connectionId, config.type);

			const { modelId } = parseModelId(data.model);
			const fullModelId = resolveModelId(modelId);

			debug.log('database', `AI SQL generate: model=${fullModelId}`);

			const client = getAnthropicClient();
			const response = await client.messages.create({
				model: fullModelId,
				max_tokens: 1024,
				system: [
					'You are an expert SQL assistant.',
					'Respond ONLY with a valid JSON object — no markdown, no code fences, no extra text.',
					'The JSON must have exactly two fields:',
					'  "sql": the generated SQL query (valid for the given database type)',
					'  "explanation": one or two sentences explaining what the query does'
				].join('\n'),
				messages: [
					{
						role: 'user',
						content: [
							schemaContext,
							'',
							`User request: ${data.prompt}`
						].join('\n')
					}
				]
			});

			const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
			const parsed = extractJson(raw) as { sql?: string; explanation?: string } | null;

			return {
				sql: parsed?.sql ?? raw.trim(),
				explanation: parsed?.explanation ?? ''
			};
		}
	)

	// Explain an existing SQL query in plain language
	.http(
		'db:ai:explain-query',
		{
			data: t.Object({
				connectionId: t.String(),
				sql: t.String({ minLength: 1 }),
				engine: t.String(),
				model: t.String()
			}),
			response: t.Object({
				summary: t.String(),
				steps: t.Array(t.String())
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');

			const config = await getDecryptedConnection(data.connectionId);
			const schemaContext = await buildSchemaContext(data.connectionId, config.type);

			const { modelId } = parseModelId(data.model);
			const fullModelId = resolveModelId(modelId);

			debug.log('database', `AI SQL explain: model=${fullModelId}`);

			const client = getAnthropicClient();
			const response = await client.messages.create({
				model: fullModelId,
				max_tokens: 1024,
				system: [
					'You are an expert SQL teacher explaining queries to beginners.',
					'Respond ONLY with a valid JSON object — no markdown, no code fences, no extra text.',
					'The JSON must have exactly two fields:',
					'  "summary": a plain-language paragraph explaining what the query does (beginner-friendly, no jargon)',
					'  "steps": an array of short strings, each explaining one logical step of the query'
				].join('\n'),
				messages: [
					{
						role: 'user',
						content: [
							schemaContext,
							'',
							'SQL query to explain:',
							data.sql
						].join('\n')
					}
				]
			});

			const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
			const parsed = extractJson(raw) as { summary?: string; steps?: string[] } | null;

			return {
				summary: parsed?.summary ?? raw.trim(),
				steps: Array.isArray(parsed?.steps) ? parsed.steps : []
			};
		}
	);
