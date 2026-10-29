import { dbClientConnectionQueries } from '../../database/queries';

export function requireDbClientConnection(connectionId: string) {
	return dbClientConnectionQueries.require(connectionId);
}
