/**
 * db-client — split a SQL string into individual statements on top-level `;`.
 *
 * The splitter is aware of the contexts where a `;` must NOT split a
 * statement:
 *  - single/double-quoted strings, incl. doubled-quote (`''`, `""`) and
 *    backslash (`\'`, MySQL) escapes;
 *  - backtick-quoted identifiers (MySQL);
 *  - line (`-- …`) and block (`/* … *\/`) comments;
 *  - Postgres dollar-quoted bodies (`$$ … ; … $$`, `$tag$ … $tag$`), which
 *    routinely contain semicolons inside function / DO blocks.
 *
 * It is intentionally conservative: it never rewrites the SQL, only slices it
 * on statement boundaries. Anything it can't confidently classify is kept in
 * the current statement so the database — not this splitter — has the final say.
 *
 * `splitOnBlankLine` additionally treats a blank line (a `\n` followed by a
 * line containing only whitespace) as a statement boundary. This is OFF by
 * default because a blank line inside a single formatted statement is common
 * and would otherwise be split into invalid fragments. It exists for SQL
 * Server, where batch-sensitive DDL (`CREATE PROCEDURE`, …) is customarily
 * separated by blank lines rather than `;`.
 */
export interface SplitSqlOptions {
	splitOnBlankLine?: boolean;
}

export function splitSqlStatements(sql: string, opts?: SplitSqlOptions): string[] {
	const splitOnBlankLine = opts?.splitOnBlankLine ?? false;
	const statements: string[] = [];
	let current = '';
	let quote: "'" | '"' | '`' | null = null;
	let inLineComment = false;
	let inBlockComment = false;
	let dollarTag: string | null = null;

	let i = 0;
	const n = sql.length;
	while (i < n) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (inLineComment) {
			current += ch;
			if (ch === '\n') inLineComment = false;
			i++;
			continue;
		}

		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				current += '*/';
				i += 2;
				inBlockComment = false;
			} else {
				current += ch;
				i++;
			}
			continue;
		}

		if (dollarTag !== null) {
			if (ch === '$' && sql.startsWith(dollarTag, i)) {
				current += dollarTag;
				i += dollarTag.length;
				dollarTag = null;
			} else {
				current += ch;
				i++;
			}
			continue;
		}

		if (quote !== null) {
			// MySQL backslash escapes apply inside string literals only.
			if (ch === '\\' && quote === "'") {
				current += ch;
				if (next !== undefined) {
					current += next;
					i += 2;
				} else {
					i++;
				}
				continue;
			}
			if (ch === quote) {
				// Doubled quote is an escaped quote, not the end of the literal.
				if (next === quote) {
					current += ch + next;
					i += 2;
					continue;
				}
				quote = null;
			}
			current += ch;
			i++;
			continue;
		}

		if (ch === '-' && next === '-') {
			inLineComment = true;
			current += ch;
			i++;
			continue;
		}

		if (ch === '/' && next === '*') {
			inBlockComment = true;
			current += '/*';
			i += 2;
			continue;
		}

		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			current += ch;
			i++;
			continue;
		}

		if (ch === '$') {
			const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
			if (tagMatch) {
				dollarTag = tagMatch[0];
				current += dollarTag;
				i += dollarTag.length;
				continue;
			}
		}

		if (splitOnBlankLine && ch === '\n') {
			let j = i + 1;
			let isBlankLine = false;
			while (j < n) {
				const c2 = sql[j];
				if (c2 === ' ' || c2 === '\t' || c2 === '\r') {
					j++;
				} else if (c2 === '\n') {
					isBlankLine = true;
					break;
				} else {
					break;
				}
			}
			if (isBlankLine) {
				const stmt = current.trim();
				if (stmt) {
					statements.push(stmt);
				}
				current = '';
				i = j + 1;
				continue;
			}
		}

		if (ch === ';') {
			if (current.trim()) statements.push(current.trim());
			current = '';
			i++;
			continue;
		}

		current += ch;
		i++;
	}

	if (current.trim()) statements.push(current.trim());
	return statements;
}
