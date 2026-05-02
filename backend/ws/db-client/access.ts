import type { WSConnection } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { dbClientConnectionQueries } from '../../database/queries';

export interface DbClientPrincipal {
	userId: string;
	isAdmin: boolean;
}

export function getDbClientPrincipal(conn: WSConnection): DbClientPrincipal {
	const userId = ws.getUserId(conn);
	const isAdmin = ws.getRole(conn) === 'admin';
	return { userId, isAdmin };
}

export function requireDbClientConnectionAccess(conn: WSConnection, connectionId: string) {
	const { userId, isAdmin } = getDbClientPrincipal(conn);
	return dbClientConnectionQueries.ensureAccess(connectionId, userId, isAdmin);
}
