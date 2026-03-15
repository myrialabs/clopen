/**
 * Schema Versioning Helpers
 * Computes column state after changes, and generates reverse (down) SQL for rollback.
 */

import { nanoid } from 'nanoid';
import type { DBType } from '$shared/types/db-manager';
import type { AlterChange, AlterPreview, DBColumnDef } from '$shared/types/alter-table';
import { generateAlterStatements } from './alter-table-generator';

/**
 * Applies a list of AlterChange objects to a column snapshot,
 * producing the resulting column list.
 */
export function applyChangesToColumns(columns: DBColumnDef[], changes: AlterChange[]): DBColumnDef[] {
	let result = [...columns];

	for (const change of changes) {
		switch (change.type) {
			case 'add':
				if (change.newDef) result.push(change.newDef);
				break;

			case 'drop':
				result = result.filter((c) => c.name !== change.columnName);
				break;

			case 'rename':
				result = result.map((c) =>
					c.name === change.columnName ? { ...c, name: change.newName! } : c
				);
				break;

			case 'modify':
				result = result.map((c) =>
					c.name === change.columnName ? { ...c, ...change.newDef } : c
				);
				break;
		}
	}

	return result;
}

/**
 * Generates the reverse (down) SQL that would undo the given changes.
 * Processes changes in reverse order so dependencies are correctly unwound.
 */
export function generateDownStatements(
	dbType: DBType,
	tableName: string,
	schema: string | undefined,
	changes: AlterChange[],
	columnsBefore: DBColumnDef[]
): AlterPreview {
	const columnsAfter = applyChangesToColumns(columnsBefore, changes);
	const reverseChanges: AlterChange[] = [];

	// Iterate in reverse so each undo step targets the correct column name
	for (let i = changes.length - 1; i >= 0; i--) {
		const change = changes[i];

		switch (change.type) {
			case 'add': {
				// Undo: drop the newly added column
				const addedName = change.newDef?.name ?? change.columnName;
				reverseChanges.push({ id: nanoid(), type: 'drop', columnName: addedName });
				break;
			}

			case 'drop': {
				// Undo: re-add the dropped column from its original definition
				const original = columnsBefore.find((c) => c.name === change.columnName);
				if (original) {
					reverseChanges.push({
						id: nanoid(),
						type: 'add',
						columnName: original.name,
						newDef: original
					});
				}
				break;
			}

			case 'rename': {
				// Undo: rename back from newName → original columnName
				reverseChanges.push({
					id: nanoid(),
					type: 'rename',
					columnName: change.newName!,
					newName: change.columnName
				});
				break;
			}

			case 'modify': {
				// Undo: restore the original column definition
				const original = columnsBefore.find((c) => c.name === change.columnName);
				if (original) {
					reverseChanges.push({
						id: nanoid(),
						type: 'modify',
						columnName: change.columnName,
						newDef: original
					});
				}
				break;
			}
		}
	}

	return generateAlterStatements(dbType, tableName, schema, reverseChanges, columnsAfter);
}
