import type { IDisposable, languages } from 'monaco-editor';
import type { DBColumn } from '$shared/types/db-manager';

const SQL_KEYWORDS = [
	'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
	'CROSS JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
	'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET', 'VALUES', 'AS', 'DISTINCT',
	'AND', 'OR', 'NOT', 'IN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'BETWEEN',
	'EXISTS', 'WITH', 'UNION', 'UNION ALL', 'COALESCE', 'NULLIF',
	'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
	'CREATE TABLE', 'DROP TABLE', 'ALTER TABLE', 'INDEX', 'UNIQUE',
	'PRIMARY KEY', 'FOREIGN KEY', 'ASC', 'DESC', 'NULL', 'NOT NULL',
	'DEFAULT', 'REFERENCES', 'CASCADE', 'CONSTRAINT'
];

/**
 * Registers a global Monaco completion provider for 'sql' language.
 * Returns a disposable for cleanup on unmount.
 */
export function registerSqlCompletion(
	monaco: typeof import('monaco-editor'),
	getSchema: () => Record<string, DBColumn[]>
): IDisposable {
	return monaco.languages.registerCompletionItemProvider('sql', {
		triggerCharacters: ['.', ' ', '\n'],
		provideCompletionItems(model, position) {
			const schema = getSchema();
			const tableNames = Object.keys(schema);

			// Get text up to cursor
			const textUntilPosition = model.getValueInRange({
				startLineNumber: 1,
				startColumn: 1,
				endLineNumber: position.lineNumber,
				endColumn: position.column
			});

			const range = {
				startLineNumber: position.lineNumber,
				endLineNumber: position.lineNumber,
				startColumn: position.column,
				endColumn: position.column
			};

			// Check for tableName. context (column completions)
			const dotMatch = textUntilPosition.match(/(\w+)\.\w*$/);
			if (dotMatch) {
				const tableName = dotMatch[1];
				const columns = schema[tableName] ?? schema[tableName.toLowerCase()] ?? [];
				if (columns.length > 0) {
					return {
						suggestions: columns.map((col) => ({
							label: col.name,
							kind: monaco.languages.CompletionItemKind.Field,
							insertText: col.name,
							detail: col.type,
							documentation: [
								col.primaryKey ? 'PRIMARY KEY' : null,
								!col.nullable ? 'NOT NULL' : null,
								col.defaultValue != null ? `DEFAULT ${col.defaultValue}` : null
							]
								.filter(Boolean)
								.join(', '),
							range
						}))
					};
				}
			}

			// Check for FROM/JOIN context (table name completions only)
			const fromJoinMatch = /\b(?:FROM|JOIN)\s+\w*$/i.test(textUntilPosition);
			if (fromJoinMatch) {
				return {
					suggestions: tableNames.map((tbl) => ({
						label: tbl,
						kind: monaco.languages.CompletionItemKind.Class,
						insertText: tbl,
						detail: 'table',
						range
					}))
				};
			}

			// Default: keywords + all table names + all columns (deduplicated)
			const columnNames = new Set<string>();
			for (const cols of Object.values(schema)) {
				for (const col of cols) {
					columnNames.add(col.name);
				}
			}

			const suggestions: languages.CompletionItem[] = [
				...SQL_KEYWORDS.map((kw) => ({
					label: kw,
					kind: monaco.languages.CompletionItemKind.Keyword,
					insertText: kw,
					range
				})),
				...tableNames.map((tbl) => ({
					label: tbl,
					kind: monaco.languages.CompletionItemKind.Class,
					insertText: tbl,
					detail: 'table',
					range
				})),
				...[...columnNames].map((col) => ({
					label: col,
					kind: monaco.languages.CompletionItemKind.Field,
					insertText: col,
					detail: 'column',
					range
				}))
			];

			return { suggestions };
		}
	});
}
