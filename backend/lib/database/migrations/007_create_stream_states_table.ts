import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Create stream states table for persistent background streaming';

export const up = (db: DatabaseConnection): void => {
  debug.log('migration', '📋 Creating stream_states table...');
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_states (
      stream_id TEXT PRIMARY KEY,
      chat_session_id TEXT NOT NULL,
      project_id TEXT,
      process_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'error', 'cancelled')),
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      last_message_index INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_session_id) REFERENCES chat_sessions (id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX idx_stream_states_session ON stream_states(chat_session_id)
  `);
  
  db.exec(`
    CREATE INDEX idx_stream_states_status ON stream_states(status)
  `);
  
  debug.log('migration', '✅ stream_states table created successfully');
};

export const down = (db: DatabaseConnection): void => {
  debug.log('migration', '🗑️ Dropping stream_states table...');
  db.exec(`DROP TABLE IF EXISTS stream_states`);
  debug.log('migration', '✅ stream_states table dropped');
};