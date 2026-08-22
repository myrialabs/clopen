/**
 * db-client — connection types shared between backend and frontend.
 */

export type DbDriver = 'mysql' | 'postgres' | 'sqlite' | 'mongodb' | 'redis' | 'mssql';
export type DbSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';
export type DbSshAuthMethod = 'password' | 'key';

export interface DbClientSshConfig {
	enabled: boolean;
	/**
	 * When set, the tunnel is opened through this saved SSH connection and every
	 * field below is ignored. Keeping both modes means existing connections that
	 * carry their own credentials keep working untouched.
	 */
	connectionId?: string | null;
	host: string;
	port: number;
	username: string;
	authMethod: DbSshAuthMethod;
	password?: string;
	privateKey?: string;
	passphrase?: string;
}

export interface DbClientConnection {
	id: string;
	name: string;
	driver: DbDriver;
	host: string | null;
	port: number | null;
	username: string | null;
	password: string | null;
	database: string | null;
	sslMode: DbSslMode;
	sslCa: string | null;
	ssh: DbClientSshConfig;
	options: Record<string, unknown>;
	color: string | null;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
}

export interface DbClientConnectionInput {
	name: string;
	driver: DbDriver;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	database?: string;
	sslMode?: DbSslMode;
	sslCa?: string;
	ssh?: Partial<DbClientSshConfig>;
	options?: Record<string, unknown>;
	color?: string;
}

export interface DbClientHealth {
	ok: boolean;
	latencyMs: number | null;
	serverVersion: string | null;
	sshOk: boolean | null;
	error: string | null;
}
