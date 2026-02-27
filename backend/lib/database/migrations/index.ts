// Import all migrations
import * as migration001 from './001_create_projects_table';
import * as migration002 from './002_create_chat_sessions_table';
import * as migration003 from './003_create_messages_table';
import * as migration004 from './004_create_prompt_templates_table';
import * as migration005 from './005_create_settings_table';
import * as migration006 from './006_add_user_to_messages';
import * as migration007 from './007_create_stream_states_table';
import * as migration008 from './008_create_message_snapshots_table';
import * as migration009 from './009_add_delta_snapshot_fields';
import * as migration010 from './010_add_soft_delete_and_branch_support';
import * as migration011 from './011_git_like_commit_graph';
import * as migration012 from './012_add_file_change_statistics';
import * as migration013 from './013_checkpoint_tree_state';
import * as migration014 from './014_add_engine_to_sessions';
import * as migration015 from './015_add_model_to_sessions';
import * as migration016 from './016_create_user_projects_table';
import * as migration017 from './017_add_current_session_to_user_projects';
import * as migration018 from './018_create_claude_accounts_table';
import * as migration019 from './019_add_claude_account_to_sessions';
import * as migration020 from './020_add_snapshot_tree_hash';
import * as migration021 from './021_drop_prompt_templates_table';

// Export all migrations in order
export const migrations = [
	{
		id: '001',
		description: migration001.description,
		up: migration001.up,
		down: migration001.down
	},
	{
		id: '002',
		description: migration002.description,
		up: migration002.up,
		down: migration002.down
	},
	{
		id: '003',
		description: migration003.description,
		up: migration003.up,
		down: migration003.down
	},
	{
		id: '004',
		description: migration004.description,
		up: migration004.up,
		down: migration004.down
	},
	{
		id: '005',
		description: migration005.description,
		up: migration005.up,
		down: migration005.down
	},
	{
		id: '006',
		description: migration006.description,
		up: migration006.up,
		down: migration006.down
	},
	{
		id: '007',
		description: migration007.description,
		up: migration007.up,
		down: migration007.down
	},
	{
		id: '008',
		description: migration008.description,
		up: migration008.up,
		down: migration008.down
	},
	{
		id: '009',
		description: migration009.description,
		up: migration009.up,
		down: migration009.down
	},
	{
		id: '010',
		description: migration010.description,
		up: migration010.up,
		down: migration010.down
	},
	{
		id: '011',
		description: migration011.description,
		up: migration011.up,
		down: migration011.down
	},
	{
		id: '012',
		description: migration012.description,
		up: migration012.up,
		down: migration012.down
	},
	{
		id: '013',
		description: migration013.description,
		up: migration013.up,
		down: migration013.down
	},
	{
		id: '014',
		description: migration014.description,
		up: migration014.up,
		down: migration014.down
	},
	{
		id: '015',
		description: migration015.description,
		up: migration015.up,
		down: migration015.down
	},
	{
		id: '016',
		description: migration016.description,
		up: migration016.up,
		down: migration016.down
	},
	{
		id: '017',
		description: migration017.description,
		up: migration017.up,
		down: migration017.down
	},
	{
		id: '018',
		description: migration018.description,
		up: migration018.up,
		down: migration018.down
	},
	{
		id: '019',
		description: migration019.description,
		up: migration019.up,
		down: migration019.down
	},
	{
		id: '020',
		description: migration020.description,
		up: migration020.up,
		down: migration020.down
	},
	{
		id: '021',
		description: migration021.description,
		up: migration021.up,
		down: migration021.down
	}
];

export default migrations;