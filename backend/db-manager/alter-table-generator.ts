/**
 * Table Architect — SQL Generator
 * Produces ALTER TABLE statements per database dialect from a list of AlterChange objects.
 * Validates destructive changes and returns warnings.
 */

import type { DBType } from '$shared/types/db-manager';
import type {
	AlterChange,
	AlterPreview,
	AlterWarning,
	DBColumnDef,
	ForeignKeyDef
} from '$shared/types/alter-table';

// ─── Identifier quoting (replicates index.ts helpers, kept local to avoid circular dep) ──

function q(name: string, type: DBType): string {
	if (type === 'mysql' || type === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
	if (type === 'mssql') return `[${name.replace(/\]/g, ']]')}]`;
	return `"${name.replace(/"/g, '""')}"`;
}

function tRef(tableName: string, schema: string | undefined, type: DBType): string {
	if (type === 'sqlite' || type === 'mysql' || type === 'mariadb') return q(tableName, type);
	if (schema) return `${q(schema, type)}.${q(tableName, type)}`;
	return q(tableName, type);
}

function fmtDefault(val: string | null | undefined): string {
	if (!val) return '';
	// Numeric or SQL keyword — no quoting
	if (/^-?\d+(\.\d+)?$/.test(val) || /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|NOW\(\)|GETDATE\(\))$/i.test(val)) {
		return val;
	}
	return `'${val.replace(/'/g, "''")}'`;
}

// ─── Column definition → SQL fragment ────────────────────────────────────────

function colDefSql(col: DBColumnDef, type: DBType): string {
	const parts: string[] = [q(col.name, type), col.type];

	if (!col.nullable) parts.push('NOT NULL');
	if (col.unique && !col.primaryKey) parts.push('UNIQUE');
	if (col.defaultValue != null && col.defaultValue !== '') {
		parts.push(`DEFAULT ${fmtDefault(col.defaultValue)}`);
	}
	return parts.join(' ');
}

// ─── FK constraint name generator ────────────────────────────────────────────

function fkName(tableName: string, col: string): string {
	return `fk_${tableName}_${col}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

function uniqName(tableName: string, col: string): string {
	return `uq_${tableName}_${col}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

// ─── Per-dialect generators ───────────────────────────────────────────────────

function genPostgres(
	tbl: string,
	schema: string | undefined,
	change: AlterChange
): string[] {
	const ref = tRef(tbl, schema, 'postgresql');
	const stmts: string[] = [];

	if (change.type === 'drop') {
		stmts.push(`ALTER TABLE ${ref} DROP COLUMN ${q(change.columnName, 'postgresql')};`);
		return stmts;
	}

	if (change.type === 'rename' && change.newName) {
		stmts.push(`ALTER TABLE ${ref} RENAME COLUMN ${q(change.columnName, 'postgresql')} TO ${q(change.newName, 'postgresql')};`);
		return stmts;
	}

	const def = change.newDef!;

	if (change.type === 'add') {
		const col = colDefSql(def, 'postgresql');
		stmts.push(`ALTER TABLE ${ref} ADD COLUMN ${col};`);

		if (def.unique) {
			stmts.push(`ALTER TABLE ${ref} ADD CONSTRAINT ${q(uniqName(tbl, def.name), 'postgresql')} UNIQUE (${q(def.name, 'postgresql')});`);
		}
		if (def.foreignKey) {
			const fk = def.foreignKey;
			const fkRef = tRef(fk.table, schema, 'postgresql');
			stmts.push(
				`ALTER TABLE ${ref} ADD CONSTRAINT ${q(fkName(tbl, def.name), 'postgresql')} FOREIGN KEY (${q(def.name, 'postgresql')}) REFERENCES ${fkRef} (${q(fk.column, 'postgresql')})` +
				(fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '') +
				(fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '') + ';'
			);
		}
		return stmts;
	}

	// modify
	const colName = q(change.columnName, 'postgresql');
	const newColName = q(def.name, 'postgresql');

	if (change.columnName !== def.name) {
		stmts.push(`ALTER TABLE ${ref} RENAME COLUMN ${colName} TO ${newColName};`);
	}
	stmts.push(`ALTER TABLE ${ref} ALTER COLUMN ${newColName} TYPE ${def.type};`);
	stmts.push(def.nullable
		? `ALTER TABLE ${ref} ALTER COLUMN ${newColName} DROP NOT NULL;`
		: `ALTER TABLE ${ref} ALTER COLUMN ${newColName} SET NOT NULL;`
	);
	if (def.defaultValue != null && def.defaultValue !== '') {
		stmts.push(`ALTER TABLE ${ref} ALTER COLUMN ${newColName} SET DEFAULT ${fmtDefault(def.defaultValue)};`);
	} else {
		stmts.push(`ALTER TABLE ${ref} ALTER COLUMN ${newColName} DROP DEFAULT;`);
	}

	// Handle unique constraint change
	stmts.push(`-- Unique constraint for ${def.name}: ${def.unique ? 'add' : 'drop if exists'}`);
	if (def.unique) {
		stmts.push(`ALTER TABLE ${ref} ADD CONSTRAINT IF NOT EXISTS ${q(uniqName(tbl, def.name), 'postgresql')} UNIQUE (${newColName});`);
	}
	// FK
	if (def.foreignKey) {
		const fk = def.foreignKey;
		const fkRef = tRef(fk.table, schema, 'postgresql');
		stmts.push(
			`ALTER TABLE ${ref} ADD CONSTRAINT ${q(fkName(tbl, def.name), 'postgresql')} FOREIGN KEY (${newColName}) REFERENCES ${fkRef} (${q(fk.column, 'postgresql')})` +
			(fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '') +
			(fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '') + ';'
		);
	}

	return stmts;
}

function genMysql(
	tbl: string,
	_schema: string | undefined,
	change: AlterChange
): string[] {
	const ref = q(tbl, 'mysql');
	const stmts: string[] = [];

	if (change.type === 'drop') {
		stmts.push(`ALTER TABLE ${ref} DROP COLUMN ${q(change.columnName, 'mysql')};`);
		return stmts;
	}

	if (change.type === 'rename' && change.newName) {
		stmts.push(`ALTER TABLE ${ref} RENAME COLUMN ${q(change.columnName, 'mysql')} TO ${q(change.newName, 'mysql')};`);
		return stmts;
	}

	const def = change.newDef!;

	if (change.type === 'add') {
		const col = colDefSql(def, 'mysql');
		stmts.push(`ALTER TABLE ${ref} ADD COLUMN ${col};`);
		if (def.foreignKey) {
			const fk = def.foreignKey;
			stmts.push(
				`ALTER TABLE ${ref} ADD CONSTRAINT ${q(fkName(tbl, def.name), 'mysql')} FOREIGN KEY (${q(def.name, 'mysql')}) REFERENCES ${q(fk.table, 'mysql')} (${q(fk.column, 'mysql')})` +
				(fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '') +
				(fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '') + ';'
			);
		}
		return stmts;
	}

	// modify — use CHANGE COLUMN for rename+modify, MODIFY COLUMN otherwise
	const def2 = def;
	if (change.columnName !== def2.name) {
		stmts.push(`ALTER TABLE ${ref} CHANGE COLUMN ${q(change.columnName, 'mysql')} ${colDefSql(def2, 'mysql')};`);
	} else {
		stmts.push(`ALTER TABLE ${ref} MODIFY COLUMN ${colDefSql(def2, 'mysql')};`);
	}
	if (def2.foreignKey) {
		const fk = def2.foreignKey;
		stmts.push(
			`ALTER TABLE ${ref} ADD CONSTRAINT ${q(fkName(tbl, def2.name), 'mysql')} FOREIGN KEY (${q(def2.name, 'mysql')}) REFERENCES ${q(fk.table, 'mysql')} (${q(fk.column, 'mysql')})` +
			(fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '') +
			(fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '') + ';'
		);
	}

	return stmts;
}

function genMssql(
	tbl: string,
	schema: string | undefined,
	change: AlterChange
): string[] {
	const ref = tRef(tbl, schema, 'mssql');
	const stmts: string[] = [];

	if (change.type === 'drop') {
		stmts.push(`ALTER TABLE ${ref} DROP COLUMN ${q(change.columnName, 'mssql')};`);
		return stmts;
	}

	if (change.type === 'rename' && change.newName) {
		stmts.push(`EXEC sp_rename '${tbl}.${change.columnName}', '${change.newName}', 'COLUMN';`);
		return stmts;
	}

	const def = change.newDef!;

	if (change.type === 'add') {
		const col = colDefSql(def, 'mssql');
		stmts.push(`ALTER TABLE ${ref} ADD ${col};`);
		if (def.unique) {
			stmts.push(`ALTER TABLE ${ref} ADD CONSTRAINT ${q(uniqName(tbl, def.name), 'mssql')} UNIQUE (${q(def.name, 'mssql')});`);
		}
		if (def.foreignKey) {
			const fk = def.foreignKey;
			const fkRef = tRef(fk.table, schema, 'mssql');
			stmts.push(
				`ALTER TABLE ${ref} ADD CONSTRAINT ${q(fkName(tbl, def.name), 'mssql')} FOREIGN KEY (${q(def.name, 'mssql')}) REFERENCES ${fkRef} (${q(fk.column, 'mssql')})` +
				(fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '') +
				(fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '') + ';'
			);
		}
		return stmts;
	}

	// modify
	if (change.columnName !== def.name) {
		stmts.push(`EXEC sp_rename '${tbl}.${change.columnName}', '${def.name}', 'COLUMN';`);
	}
	stmts.push(`ALTER TABLE ${ref} ALTER COLUMN ${colDefSql(def, 'mssql')};`);
	if (def.foreignKey) {
		const fk = def.foreignKey;
		const fkRef = tRef(fk.table, schema, 'mssql');
		stmts.push(
			`ALTER TABLE ${ref} ADD CONSTRAINT ${q(fkName(tbl, def.name), 'mssql')} FOREIGN KEY (${q(def.name, 'mssql')}) REFERENCES ${fkRef} (${q(fk.column, 'mssql')})` +
			(fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '') +
			(fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '') + ';'
		);
	}

	return stmts;
}

/**
 * SQLite: generate full table recreation SQL.
 * Applies the changes to the column list, then outputs:
 *   CREATE TABLE new → INSERT SELECT → DROP old → RENAME new → old
 */
function genSqliteRecreate(
	tbl: string,
	changes: AlterChange[],
	existingColumns: DBColumnDef[]
): string[] {
	// Build new column list by applying changes
	let cols: DBColumnDef[] = existingColumns.map((c) => ({ ...c }));

	for (const ch of changes) {
		if (ch.type === 'drop') {
			cols = cols.filter((c) => c.name !== ch.columnName);
		} else if (ch.type === 'rename' && ch.newName) {
			cols = cols.map((c) => c.name === ch.columnName ? { ...c, name: ch.newName! } : c);
		} else if (ch.type === 'modify' && ch.newDef) {
			cols = cols.map((c) => c.name === ch.columnName ? { ...ch.newDef! } : c);
		} else if (ch.type === 'add' && ch.newDef) {
			cols.push(ch.newDef);
		}
	}

	const newTbl = `${tbl}__architect_new`;
	const colDefs = cols.map((c) => {
		const parts = [q(c.name, 'sqlite'), c.type];
		if (c.primaryKey) parts.push('PRIMARY KEY');
		if (!c.nullable && !c.primaryKey) parts.push('NOT NULL');
		if (c.unique && !c.primaryKey) parts.push('UNIQUE');
		if (c.defaultValue != null && c.defaultValue !== '') parts.push(`DEFAULT ${fmtDefault(c.defaultValue)}`);
		if (c.foreignKey) {
			const fk = c.foreignKey;
			parts.push(`REFERENCES ${q(fk.table, 'sqlite')} (${q(fk.column, 'sqlite')})`);
			if (fk.onDelete) parts.push(`ON DELETE ${fk.onDelete}`);
		}
		return parts.join(' ');
	});

	// Map old col names → new for the SELECT (handle renames)
	const renames = new Map<string, string>();
	for (const ch of changes) {
		if (ch.type === 'rename' && ch.newName) renames.set(ch.columnName, ch.newName);
	}
	const droppedNames = new Set(changes.filter((c) => c.type === 'drop').map((c) => c.columnName));
	const addedNames = new Set(changes.filter((c) => c.type === 'add').map((c) => c.newDef?.name ?? ''));

	const selectCols = cols
		.filter((c) => !addedNames.has(c.name))
		.map((c) => {
			const origName = [...renames.entries()].find(([, nv]) => nv === c.name)?.[0] ?? c.name;
			return origName === c.name ? q(c.name, 'sqlite') : `${q(origName, 'sqlite')} AS ${q(c.name, 'sqlite')}`;
		});
	const insertCols = cols.filter((c) => !addedNames.has(c.name)).map((c) => q(c.name, 'sqlite'));

	const stmts = [
		`PRAGMA foreign_keys = OFF;`,
		`BEGIN TRANSACTION;`,
		`CREATE TABLE ${q(newTbl, 'sqlite')} (\n  ${colDefs.join(',\n  ')}\n);`,
		`INSERT INTO ${q(newTbl, 'sqlite')} (${insertCols.join(', ')})\n  SELECT ${selectCols.join(', ')} FROM ${q(tbl, 'sqlite')};`,
		`DROP TABLE ${q(tbl, 'sqlite')};`,
		`ALTER TABLE ${q(newTbl, 'sqlite')} RENAME TO ${q(tbl, 'sqlite')};`,
		`COMMIT;`,
		`PRAGMA foreign_keys = ON;`
	];

	return stmts;
}

/** SQLite simple ADD COLUMN (no recreation needed) */
function genSqliteAddColumn(tbl: string, def: DBColumnDef): string[] {
	const col = colDefSql(def, 'sqlite');
	return [`ALTER TABLE ${q(tbl, 'sqlite')} ADD COLUMN ${col};`];
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(
	changes: AlterChange[],
	existingColumns: DBColumnDef[],
	dbType: DBType
): AlterWarning[] {
	const warnings: AlterWarning[] = [];

	for (const ch of changes) {
		if (ch.type === 'drop') {
			warnings.push({
				severity: 'error',
				changeId: ch.id,
				message: `Dropping column "${ch.columnName}" will permanently delete all data stored in it. This cannot be undone.`
			});
		}

		if (ch.type === 'modify' && ch.newDef) {
			const original = existingColumns.find((c) => c.name === ch.columnName);
			if (original && original.type.toUpperCase() !== ch.newDef.type.toUpperCase()) {
				warnings.push({
					severity: 'warning',
					changeId: ch.id,
					message: `Changing type of "${ch.columnName}" from ${original.type} → ${ch.newDef.type} may cause data conversion errors or truncation.`
				});
			}
			if (original && original.nullable && !ch.newDef.nullable && !ch.newDef.defaultValue) {
				warnings.push({
					severity: 'warning',
					changeId: ch.id,
					message: `Adding NOT NULL to "${ch.columnName}" without a DEFAULT will fail if any existing rows have NULL in this column.`
				});
			}
			if (original?.foreignKey && !ch.newDef.foreignKey) {
				warnings.push({
					severity: 'warning',
					changeId: ch.id,
					message: `Removing the FOREIGN KEY on "${ch.columnName}" will drop the referential integrity constraint.`
				});
			}
		}

		if (ch.type === 'add' && ch.newDef && !ch.newDef.nullable && !ch.newDef.defaultValue) {
			if (dbType !== 'sqlite') {
				warnings.push({
					severity: 'warning',
					changeId: ch.id,
					message: `Adding NOT NULL column "${ch.newDef.name}" without a DEFAULT will fail if the table already has rows.`
				});
			}
		}

		if (dbType === 'sqlite' && ch.type !== 'add') {
			warnings.push({
				severity: 'warning',
				changeId: ch.id,
				message: `SQLite requires full table recreation for "${ch.type}" operations. Existing data will be preserved.`
			});
		}
	}

	return warnings;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateAlterStatements(
	dbType: DBType,
	tableName: string,
	schema: string | undefined,
	changes: AlterChange[],
	existingColumns: DBColumnDef[]
): AlterPreview {
	if (!changes.length) {
		return { statements: [], warnings: [], requiresRecreate: false, transactional: false, hasErrors: false };
	}

	const warnings = validate(changes, existingColumns, dbType);
	const hasErrors = warnings.some((w) => w.severity === 'error');
	let statements: string[] = [];
	let requiresRecreate = false;
	let transactional = false;

	if (dbType === 'mongodb' || dbType === 'redis') {
		return {
			statements: [],
			warnings: [{ severity: 'error', changeId: changes[0].id, message: `ALTER TABLE is not supported for ${dbType}.` }],
			requiresRecreate: false,
			transactional: false,
			hasErrors: true
		};
	}

	if (dbType === 'sqlite') {
		// Check if any change requires recreation
		const needsRecreate = changes.some((ch) => ch.type !== 'add');
		if (needsRecreate) {
			requiresRecreate = true;
			transactional = true;
			statements = genSqliteRecreate(tableName, changes, existingColumns);
		} else {
			// Only ADDs — generate simple ADD COLUMN statements
			for (const ch of changes) {
				if (ch.type === 'add' && ch.newDef) {
					statements.push(...genSqliteAddColumn(tableName, ch.newDef));
				}
			}
		}
		return { statements, warnings, requiresRecreate, transactional, hasErrors };
	}

	// SQL server databases: one statement group per change
	transactional = true;
	for (const ch of changes) {
		if (dbType === 'postgresql') {
			statements.push(...genPostgres(tableName, schema, ch));
		} else if (dbType === 'mysql' || dbType === 'mariadb') {
			statements.push(...genMysql(tableName, schema, ch));
		} else if (dbType === 'mssql') {
			statements.push(...genMssql(tableName, schema, ch));
		}
	}

	return { statements, warnings, requiresRecreate, transactional, hasErrors };
}
