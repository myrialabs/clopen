import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const seed = (db: DatabaseConnection): void => {
	debug.log('seeder', '🌱 Seeding default settings...');

	const now = new Date().toISOString();

	// Insert default settings
	const insertSetting = db.prepare(`
		INSERT INTO settings (key, value, updated_at)
		VALUES (?, ?, ?)
	`);

	const defaultSettings = [
		{
			key: 'claude_model',
			value: 'sonnet',
			description: 'Default Claude model for chat'
		},
		{ 
			key: 'max_tokens', 
			value: '4000',
			description: 'Maximum tokens per response'
		},
		{ 
			key: 'temperature', 
			value: '0.3',
			description: 'AI response creativity (0.0 - 1.0)'
		},
		{ 
			key: 'auto_save_sessions', 
			value: 'true',
			description: 'Automatically save chat sessions'
		},
		{ 
			key: 'file_watch_enabled', 
			value: 'true',
			description: 'Enable file system watching'
		},
		{ 
			key: 'theme', 
			value: 'system',
			description: 'UI theme preference (light/dark/system)'
		},
		{ 
			key: 'session_timeout', 
			value: '3600000',
			description: 'Session timeout in milliseconds (1 hour)'
		},
		{
			key: 'enable_notifications',
			value: 'true',
			description: 'Enable desktop notifications'
		},
		{
			key: 'auto_cleanup_old_sessions',
			value: 'false',
			description: 'Automatically clean up old chat sessions'
		},
		{
			key: 'default_project_template',
			value: 'svelte',
			description: 'Default template for new projects'
		}
	];

	for (const setting of defaultSettings) {
		try {
			insertSetting.run(setting.key, setting.value, now);
		} catch (error) {
			// Skip if setting already exists
			if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
				debug.log('seeder', `ℹ️  Setting ${setting.key} already exists, skipping`);
			} else {
				throw error;
			}
		}
	}

	debug.log('seeder', `✅ Seeded ${defaultSettings.length} default settings`);
};

export const description = 'Seed default application settings and configuration';