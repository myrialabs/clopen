/**
 * Environment configuration for Claude Code engine.
 *
 * Builds an env dictionary to pass via SDK Options.env
 * instead of mutating process.env directly.
 * This avoids global state race conditions when multiple projects
 * stream concurrently.
 */

import { homedir } from 'os';
import { join } from 'path';
import { isWindows, findGitBash } from '../../../terminal/shell-utils.js';
import { engineQueries } from '../../../database/queries';
import { debug } from '$shared/utils/logger';

let _ready = false;
let _initPromise: Promise<void> | null = null;
let _envOverrides: Record<string, string> = {};

/**
 * Returns the isolated Claude config directory under ~/.clopen/claude/user/
 */
export function getClaudeUserConfigDir(): string {
  return join(homedir(), '.clopen', 'claude', 'user');
}

/**
 * Resets environment state so the next setupEnvironmentOnce() re-reads
 * the active account token from DB. Called after account switch/delete.
 */
export function resetEnvironment(): void {
  _ready = false;
  _initPromise = null;
  _envOverrides = {};
}

/**
 * Idempotent, concurrency-safe environment setup.
 * Multiple concurrent calls share a single initialization promise.
 */
export async function setupEnvironmentOnce(): Promise<void> {
  if (_ready) return;
  if (_initPromise) return _initPromise;

  _initPromise = _doSetup();
  try {
    await _initPromise;
  } catch (error) {
    _initPromise = null;
    throw error;
  }
}

/**
 * Returns the env dictionary for SDK Options.env.
 * Merges process.env with our overrides so the SDK subprocess
 * inherits everything it needs.
 *
 * When accountId is provided, overrides the OAuth token with that
 * specific account's token instead of the globally active account.
 */
export function getEngineEnv(accountId?: number): Record<string, string> {
  const env: Record<string, string> = {};
  // Copy process.env (filter out undefined values)
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Apply our overrides
  Object.assign(env, _envOverrides);

  // Override with specific account token if requested
  if (accountId !== undefined) {
    try {
      const accounts = engineQueries.getClaudeAccounts();
      const account = accounts.find(a => a.id === accountId);
      if (account) {
        env['CLAUDE_CODE_OAUTH_TOKEN'] = account.oauth_token;
        debug.log('engine', `Claude Code: Per-session account override → "${account.name}"`);
      }
    } catch {
      // Ignore — fall back to default token from overrides
    }
  }

  return env;
}

async function _doSetup(): Promise<void> {
  const overrides: Record<string, string> = {};

  // Bypass permissions for Claude Code
  overrides['CLAUDE_CODE_PERMISSION_MODE'] = 'bypassPermissions';

  // Isolate Claude config to ~/.clopen/claude/user/
  const claudeUserDir = getClaudeUserConfigDir();
  await ensureDirectory(claudeUserDir);
  overrides['CLAUDE_CONFIG_DIR'] = claudeUserDir;

  // Inject OAuth token from active account (if any)
  try {
    const activeAccount = engineQueries.getActiveClaudeAccount();
    if (activeAccount) {
      overrides['CLAUDE_CODE_OAUTH_TOKEN'] = activeAccount.oauth_token;
      debug.log('engine', `✅ Claude Code: Using account "${activeAccount.name}"`);
    }
  } catch {
    // DB may not be initialized yet during first startup
    debug.warn('engine', '⚠️ Claude Code: Could not read active account (DB may not be ready)');
  }

  // Setup Git Bash on Windows
  if (isWindows) {
    const existingPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    if (existingPath) {
      overrides['CLAUDE_CODE_GIT_BASH_PATH'] = existingPath;
    } else {
      const gitBashPath = await findGitBash();
      if (gitBashPath) {
        overrides['CLAUDE_CODE_GIT_BASH_PATH'] = gitBashPath;
        debug.log('engine', '✅ Claude Code: Git Bash configured at:', gitBashPath);
      } else {
        debug.warn('engine', '⚠️ Claude Code: Git Bash not found - may have limited functionality on Windows');
      }
    }
  }

  // Terminal environment variables
  overrides['FORCE_COLOR'] = '1';
  overrides['COLORTERM'] = 'truecolor';
  if (!process.env.TERM) {
    overrides['TERM'] = 'xterm-256color';
  }

  _envOverrides = overrides;
  _ready = true;
  debug.log('engine', '✅ Environment configured (one-time setup)');
}

async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await Bun.file(dirPath).stat();
  } catch {
    // Directory doesn't exist, create via temp file workaround
    const tempFile = join(dirPath, '.init');
    await Bun.write(tempFile, '');
    try {
      if (await Bun.file(tempFile).exists()) {
        if (process.platform === 'win32') {
          await Bun.spawn(['cmd', '/c', 'del', '/f', '/q', tempFile.replace(/\//g, '\\')], {
            stdout: 'ignore', stderr: 'ignore'
          }).exited;
        } else {
          await Bun.spawn(['rm', '-f', tempFile], {
            stdout: 'ignore', stderr: 'ignore'
          }).exited;
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
