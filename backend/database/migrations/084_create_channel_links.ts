import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';

export const description = 'Create chat-app channel links and channel messages';

/**
 * Two tables, and neither holds a credential — the bot token lives on the
 * `integration_accounts` row a link points at, sealed there.
 *
 * `channel_links` is one CHAT paired with one Clopen USER through one
 * connected bot. A member's chat starts `pending` until an admin approves it;
 * `is_enabled` turns a chat off entirely (it can then do nothing at all). It
 * also carries the chat's ACTIVE TARGET: the project and session a plain
 * message continues.
 *
 * `channel_messages` maps chat messages to Clopen in both directions: a
 * question waiting for an answer, a menu or a confirmation whose buttons
 * name its row, an answer or a user message a reply or an edit can act on.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating channel tables...');

	db.exec(`
		CREATE TABLE channel_links (
			id                 TEXT PRIMARY KEY,
			account_id         TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
			user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			conversation_id    TEXT NOT NULL,
			platform_user_id   TEXT NOT NULL,
			display_name       TEXT,
			status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
			is_enabled         INTEGER NOT NULL DEFAULT 1,
			active_project_id  TEXT,
			active_session_id  TEXT,
			created_at         TEXT NOT NULL,
			last_used_at       TEXT,
			UNIQUE (account_id, conversation_id)
		)
	`);
	db.exec('CREATE INDEX idx_channel_links_user ON channel_links (user_id)');

	db.exec(`
		CREATE TABLE channel_messages (
			id                   TEXT PRIMARY KEY,
			link_id              TEXT NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
			kind                 TEXT NOT NULL CHECK (kind IN ('question', 'answer', 'user', 'menu', 'confirm')),
			project_id           TEXT,
			chat_session_id      TEXT,
			tool_use_id          TEXT,
			question_index       INTEGER,
			clopen_message_id    TEXT,
			platform_message_id  TEXT NOT NULL,
			state                TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'closed')),
			payload              TEXT NOT NULL DEFAULT '{}',
			created_at           TEXT NOT NULL
		)
	`);
	db.exec('CREATE INDEX idx_channel_messages_message ON channel_messages (link_id, platform_message_id)');
	db.exec('CREATE INDEX idx_channel_messages_tool_use ON channel_messages (tool_use_id)');
	db.exec('CREATE INDEX idx_channel_messages_session ON channel_messages (chat_session_id, state)');

	debug.log('migration', '✅ Channel tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping channel tables...');
	db.exec('DROP TABLE IF EXISTS channel_messages');
	db.exec('DROP TABLE IF EXISTS channel_links');
	debug.log('migration', '✅ Channel tables dropped');
};
