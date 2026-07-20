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
import * as migration022 from './022_add_snapshot_changes_column';
import * as migration023 from './023_create_user_unread_sessions_table';
import * as migration024 from './024_create_users_table';
import * as migration025 from './025_create_auth_sessions_table';
import * as migration026 from './026_create_invite_tokens_table';
import * as migration027 from './027_create_opencode_providers_table';
import * as migration028 from './028_create_opencode_accounts_table';
import * as migration029 from './029_migrate_messages_to_unified';
import * as migration030 from './030_add_files_panel_state_to_user_projects';
import * as migration031 from './031_create_db_client_tables';
import * as migration032 from './032_seed_copilot_provider';
import * as migration033 from './033_seed_codex_provider';
import * as migration034 from './034_seed_qwen_provider';
import * as migration035 from './035_add_owner_to_db_client_connections';
import * as migration036 from './036_create_auth_audit_log';
import * as migration037 from './037_repair_auth_audit_log_schema';
import * as migration038 from './038_add_workspace_state_to_user_projects';
import * as migration039 from './039_create_file_audit_log';
import * as migration040 from './040_create_mcp_servers_table';
import * as migration041 from './041_add_mcp_config_schema';
import * as migration042 from './042_add_mcp_oauth';
import * as migration043 from './043_relocate_engine_config_dirs';
import * as migration044 from './044_create_skills_table';
import * as migration045 from './045_create_commands_table';
import * as migration046 from './046_create_subagents_table';
import * as migration047 from './047_create_instructions_table';
import * as migration048 from './048_add_mcp_tool_overrides';
import * as migration049 from './049_create_permission_sets_table';
import * as migration050 from './050_create_profiles_tables';
import * as migration051 from './051_add_profile_to_sessions';
import * as migration052 from './052_add_default_profile_to_projects';
import * as migration053 from './053_add_profile_to_permission_sets';
import * as migration054 from './054_drop_subagent_agent_type';
import * as migration055 from './055_artifact_model_tools_per_engine';
import * as migration056 from './056_support_mssql_driver';
import * as migration057 from './057_seed_pi_provider';

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
	},
	{
		id: '022',
		description: migration022.description,
		up: migration022.up,
		down: migration022.down
	},
	{
		id: '023',
		description: migration023.description,
		up: migration023.up,
		down: migration023.down
	},
	{
		id: '024',
		description: migration024.description,
		up: migration024.up,
		down: migration024.down
	},
	{
		id: '025',
		description: migration025.description,
		up: migration025.up,
		down: migration025.down
	},
	{
		id: '026',
		description: migration026.description,
		up: migration026.up,
		down: migration026.down
	},
	{
		id: '027',
		description: migration027.description,
		up: migration027.up,
		down: migration027.down
	},
	{
		id: '028',
		description: migration028.description,
		up: migration028.up,
		down: migration028.down
	},
	{
		id: '029',
		description: migration029.description,
		up: migration029.up,
		down: migration029.down
	},
	{
		id: '030',
		description: migration030.description,
		up: migration030.up,
		down: migration030.down
	},
	{
		id: '031',
		description: migration031.description,
		up: migration031.up,
		down: migration031.down
	},
	{
		id: '032',
		description: migration032.description,
		up: migration032.up,
		down: migration032.down
	},
	{
		id: '033',
		description: migration033.description,
		up: migration033.up,
		down: migration033.down
	},
	{
		id: '034',
		description: migration034.description,
		up: migration034.up,
		down: migration034.down
	},
	{
		id: '035',
		description: migration035.description,
		up: migration035.up,
		down: migration035.down
	},
	{
		id: '036',
		description: migration036.description,
		up: migration036.up,
		down: migration036.down
	},
	{
		id: '037',
		description: migration037.description,
		up: migration037.up,
		down: migration037.down
	},
	{
		id: '038',
		description: migration038.description,
		up: migration038.up,
		down: migration038.down
	},
	{
		id: '039',
		description: migration039.description,
		up: migration039.up,
		down: migration039.down
	},
	{
		id: '040',
		description: migration040.description,
		up: migration040.up,
		down: migration040.down
	},
	{
		id: '041',
		description: migration041.description,
		up: migration041.up,
		down: migration041.down
	},
	{
		id: '042',
		description: migration042.description,
		up: migration042.up,
		down: migration042.down
	},
	{
		id: '043',
		description: migration043.description,
		up: migration043.up,
		down: migration043.down
	},
	{
		id: '044',
		description: migration044.description,
		up: migration044.up,
		down: migration044.down
	},
	{
		id: '045',
		description: migration045.description,
		up: migration045.up,
		down: migration045.down
	},
	{
		id: '046',
		description: migration046.description,
		up: migration046.up,
		down: migration046.down
	},
	{
		id: '047',
		description: migration047.description,
		up: migration047.up,
		down: migration047.down
	},
	{
		id: '048',
		description: migration048.description,
		up: migration048.up,
		down: migration048.down
	},
	{
		id: '049',
		description: migration049.description,
		up: migration049.up,
		down: migration049.down
	},
	{
		id: '050',
		description: migration050.description,
		up: migration050.up,
		down: migration050.down
	},
	{
		id: '051',
		description: migration051.description,
		up: migration051.up,
		down: migration051.down
	},
	{
		id: '052',
		description: migration052.description,
		up: migration052.up,
		down: migration052.down
	},
	{
		id: '053',
		description: migration053.description,
		up: migration053.up,
		down: migration053.down
	},
	{
		id: '054',
		description: migration054.description,
		up: migration054.up,
		down: migration054.down
	},
	{
		id: '055',
		description: migration055.description,
		up: migration055.up,
		down: migration055.down
	},
	{
		id: '056',
		description: migration056.description,
		up: migration056.up,
		down: migration056.down
	},
	{
		id: '057',
		description: migration057.description,
		up: migration057.up,
		down: migration057.down
	}
];

export default migrations;
