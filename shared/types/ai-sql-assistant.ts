/**
 * AI SQL Assistant Types
 * Shared types for LLM-powered SQL generation and query explanation.
 */

export interface AiSqlGenerateResult {
	/** The generated SQL query */
	sql: string;
	/** Brief explanation of what the query does */
	explanation: string;
}

export interface AiQueryExplainResult {
	/** Beginner-friendly summary of what the query does */
	summary: string;
	/** Step-by-step breakdown of the query logic */
	steps: string[];
}
