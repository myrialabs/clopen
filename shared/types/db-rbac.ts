/**
 * Database Manager RBAC Types
 * Role-Based Access Control for the Database Manager feature.
 */

/** DB Manager connection-level roles */
export type DBConnectionRole = 'owner' | 'developer' | 'viewer';

export const DB_CONNECTION_ROLE_LABELS: Record<DBConnectionRole, string> = {
	owner: 'Owner',
	developer: 'Developer',
	viewer: 'Viewer'
};

export const DB_CONNECTION_ROLE_DESCRIPTIONS: Record<DBConnectionRole, string> = {
	owner: 'Full access — create, delete, execute any query, manage permissions',
	developer: 'Can run DML/DDL queries and modify schema, but cannot drop databases or delete connections',
	viewer: 'Read-only access — SELECT queries and browse data only'
};

/** All granular actions checked by the permission service */
export type DBAction =
	| 'connection:view'      // View/use a connection
	| 'connection:create'    // Add a new connection
	| 'connection:update'    // Edit connection details
	| 'connection:delete'    // Delete a connection
	| 'query:select'         // Run SELECT queries / browse data
	| 'query:dml'            // INSERT / UPDATE / DELETE / TRUNCATE
	| 'query:ddl'            // CREATE / ALTER / DROP TABLE, VIEW, INDEX
	| 'query:drop_db'        // DROP DATABASE / DROP SCHEMA
	| 'data:insert'          // GUI row insert
	| 'data:update'          // GUI row update
	| 'data:delete'          // GUI row delete
	| 'data:rollback'        // Rollback a logged DML operation (owner only)
	| 'schema:alter'         // Alter table schema via GUI
	| 'audit:view'           // View the audit log
	| 'permissions:manage';  // Grant / revoke permissions

/** Permission matrix per role */
export const DB_ROLE_PERMISSIONS: Record<DBConnectionRole, DBAction[]> = {
	owner: [
		'connection:view', 'connection:create', 'connection:update', 'connection:delete',
		'query:select', 'query:dml', 'query:ddl', 'query:drop_db',
		'data:insert', 'data:update', 'data:delete', 'data:rollback',
		'schema:alter',
		'audit:view',
		'permissions:manage'
	],
	developer: [
		'connection:view', 'connection:create', 'connection:update',
		'query:select', 'query:dml', 'query:ddl',
		'data:insert', 'data:update', 'data:delete',
		'schema:alter'
	],
	viewer: [
		'connection:view',
		'query:select'
	]
};

/** Stored permission record (one per user per connection) */
export interface DBConnectionPermission {
	id: string;
	connectionId: string;
	userId: string;
	role: DBConnectionRole;
	grantedBy: string;
	grantedAt: string;
	/** Populated when listing — user display name */
	userName?: string;
	userColor?: string;
	userAvatar?: string;
}

/** Audit log entry for a single DB Manager action */
export interface DBAuditLogEntry {
	id: string;
	connectionId: string;
	connectionName: string;
	userId: string;
	userName: string;
	/** Action category key, e.g. 'query:execute', 'data:insert' */
	action: string;
	sql?: string | null;
	tableName?: string | null;
	rowCount?: number | null;
	executionTimeMs?: number | null;
	success: boolean;
	error?: string | null;
	ipAddress?: string | null;
	performedAt: string;
	/** JSON-encoded snapshot of the row(s) BEFORE the operation (UPDATE/DELETE) */
	beforeData?: string | null;
	/** JSON-encoded snapshot of the row(s) AFTER the operation (INSERT/UPDATE) */
	afterData?: string | null;
	/** Primary key column name used for rollback */
	pkColumn?: string | null;
	/** JSON-encoded primary key value(s) used for rollback */
	pkValue?: string | null;
}

/** Payload for granting a permission */
export interface DBGrantPermissionInput {
	connectionId: string;
	userId: string;
	role: DBConnectionRole;
}
