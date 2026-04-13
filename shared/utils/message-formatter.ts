/**
 * Message Formatter
 *
 * loadMessage() — DB row → UnifiedMessage
 *
 * After migration 029, the JSON blob in message is the single source
 * of truth. This function is a simple JSON.parse wrapper.
 */

import type { DatabaseMessage } from '$shared/types/database/schema';
import type { UnifiedMessage } from '$shared/types/unified';

/** Parse a DatabaseMessage row into a UnifiedMessage. */
export function loadMessage(row: DatabaseMessage): UnifiedMessage {
	return JSON.parse(row.data) as UnifiedMessage;
}
