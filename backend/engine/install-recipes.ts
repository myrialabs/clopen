/**
 * System Tool Install Recipes
 *
 * Data-driven registry of install commands for system tools that clopen
 * depends on (Git, Claude Code, OpenCode, Chrome for puppeteer). Each
 * recipe is platform-aware and privilege-aware: when the runner cannot
 * reasonably complete the install non-interactively (e.g. `apt` without
 * root, `choco` without Administrator), the recipe is marked
 * `autoInstallable: false` and the frontend renders a copy-command
 * fallback instead of the install button.
 *
 * Recipes also carry manual instructions so the frontend can always
 * surface a copy-able command and a docs link, regardless of platform.
 */

import { homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isElevated } from '$backend/utils/privilege';
import { getClopenDir } from '$backend/utils/paths';
import { resolveBinary, resolveBinaryWithRefresh } from '$backend/utils/cli';
import { resolveStaticCurlAsset } from '$backend/utils/static-curl';

export type ToolId = 'git' | 'claude' | 'opencode' | 'chrome';

export interface ManualInstruction {
	label: string;
	command: string;
	docs?: string;
}

export interface Recipe {
	tool: ToolId;
	autoInstallable: boolean;
	/** Reason displayed when autoInstallable is false. */
	unavailableReason?: string;
	/** Spawn arg vector when autoInstallable. */
	command?: string[];
	/** Optional shell to wrap command (e.g. sh -c for pipe chains). */
	shell?: { program: string; args: string[] };
	/**
	 * True when the install command (or script it downloads) shells out
	 * to `curl`. When set, the runner ensures curl is on PATH —
	 * downloading a SHA-pinned static curl from stunnel/static-curl if
	 * the system lacks one.
	 */
	requiresCurl?: boolean;
	/**
	 * When requiresCurl is true and the system has no curl, this carries
	 * the pinned asset metadata so the frontend can surface URL + SHA256
	 * in the install confirmation dialog for explicit user consent.
	 * Undefined when system curl is already present or no asset covers
	 * the current platform/arch.
	 */
	pendingCurlDownload?: { version: string; url: string; sha256: string; archKey: string };
	/** Human-readable command string for confirmation dialog preview. */
	displayCommand?: string;
	/** Extra env vars for the install subprocess. */
	env?: Record<string, string>;
	/** Missing prerequisites (other tools that must be installed first). */
	missingPrereqs: ToolId[];
	/** Manual-install options shown regardless of autoInstallable. */
	manualInstructions: ManualInstruction[];
}

export interface ToolStatus {
	tool: ToolId;
	installed: boolean;
	version: string | null;
	/** Where the binary was found (e.g. "/usr/bin/git", "system", "~/.clopen/bin"). */
	source: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Package manager detection
// ─────────────────────────────────────────────────────────────────────────────

type LinuxPkgMgr = 'apt' | 'dnf' | 'pacman' | 'apk' | 'zypper';
type WindowsPkgMgr = 'winget' | 'scoop' | 'choco';

function detectLinuxPkgMgr(): LinuxPkgMgr | null {
	if (resolveBinary('apt-get')) return 'apt';
	if (resolveBinary('dnf')) return 'dnf';
	if (resolveBinary('pacman')) return 'pacman';
	if (resolveBinary('apk')) return 'apk';
	if (resolveBinary('zypper')) return 'zypper';
	return null;
}

function detectWindowsPkgMgr(): WindowsPkgMgr | null {
	if (resolveBinary('winget')) return 'winget';
	if (resolveBinary('scoop')) return 'scoop';
	if (resolveBinary('choco')) return 'choco';
	return null;
}

function detectMacPkgMgr(): 'brew' | null {
	return resolveBinary('brew') ? 'brew' : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome detection via puppeteer cache layout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the Chrome executable path under ~/.clopen/bin using the
 * @puppeteer/browsers cache layout. Checks common Chrome build IDs by
 * scanning the cache directory.
 */
export function resolveClopenChromePath(): string | null {
	const cacheDir = join(getClopenDir(), 'bin', 'chrome');
	if (!existsSync(cacheDir)) return null;

	try {
		const entries = readdirSync(cacheDir);
		for (const entry of entries) {
			const buildDir = join(cacheDir, entry);
			let candidate: string;
			if (process.platform === 'darwin') {
				candidate = join(buildDir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
				if (existsSync(candidate)) return candidate;
				candidate = join(buildDir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
				if (existsSync(candidate)) return candidate;
			} else if (process.platform === 'win32') {
				candidate = join(buildDir, 'chrome-win64', 'chrome.exe');
				if (existsSync(candidate)) return candidate;
				candidate = join(buildDir, 'chrome-win32', 'chrome.exe');
				if (existsSync(candidate)) return candidate;
			} else {
				candidate = join(buildDir, 'chrome-linux64', 'chrome');
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {
		// Fall through
	}
	return null;
}

function detectSystemChrome(): string | null {
	if (process.platform === 'darwin') {
		const paths = [
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			'/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
			'/Applications/Chromium.app/Contents/MacOS/Chromium'
		];
		for (const p of paths) if (existsSync(p)) return p;
		return null;
	}
	if (process.platform === 'win32') {
		const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
		const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
		const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
		const paths = [
			join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
			join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
			join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
		];
		for (const p of paths) if (existsSync(p)) return p;
		return null;
	}
	return resolveBinary('google-chrome')
		?? resolveBinary('google-chrome-stable')
		?? resolveBinary('chromium')
		?? resolveBinary('chromium-browser');
}

/**
 * Preferred executable path for puppeteer. Clopen-managed install wins
 * over system Chrome so users can keep the bundled version consistent.
 */
export function getChromeExecutablePath(): string | null {
	return resolveClopenChromePath() ?? detectSystemChrome();
}

// ─────────────────────────────────────────────────────────────────────────────
// Status detection
// ─────────────────────────────────────────────────────────────────────────────

async function runVersion(binary: string, versionFlag = '--version'): Promise<string | null> {
	try {
		const proc = Bun.spawn([binary, versionFlag], { stdout: 'pipe', stderr: 'pipe' });
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;
		const stdout = await new Response(proc.stdout).text();
		const first = stdout.trim().split('\n')[0]?.trim() ?? '';
		return first || null;
	} catch {
		return null;
	}
}

export async function getToolStatus(tool: ToolId): Promise<ToolStatus> {
	if (tool === 'chrome') {
		const resolved = getChromeExecutablePath();
		if (!resolved) return { tool, installed: false, version: null, source: null };
		const version = await runVersion(resolved);
		const source = resolveClopenChromePath() ? 'clopen' : 'system';
		return { tool, installed: true, version, source };
	}

	const resolved = await resolveBinaryWithRefresh(tool);
	if (!resolved) return { tool, installed: false, version: null, source: null };
	const version = await runVersion(resolved);
	if (!version) return { tool, installed: false, version: null, source: null };
	return { tool, installed: true, version, source: resolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipe resolution
// ─────────────────────────────────────────────────────────────────────────────

async function resolveGitRecipe(): Promise<Recipe> {
	const base: Recipe = {
		tool: 'git',
		autoInstallable: false,
		missingPrereqs: [],
		manualInstructions: []
	};

	if (process.platform === 'darwin') {
		const mgr = detectMacPkgMgr();
		base.manualInstructions.push({
			label: 'Homebrew',
			command: 'brew install git',
			docs: 'https://git-scm.com/download/mac'
		});
		if (!mgr) {
			base.unavailableReason = 'Homebrew not found. Install Homebrew first.';
			base.manualInstructions.push({
				label: 'Install Homebrew',
				command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
				docs: 'https://brew.sh'
			});
			return base;
		}
		base.autoInstallable = true;
		base.command = ['brew', 'install', 'git'];
		base.displayCommand = 'brew install git';
		return base;
	}

	if (process.platform === 'win32') {
		const mgr = detectWindowsPkgMgr();
		base.manualInstructions.push(
			{ label: 'winget', command: 'winget install --id Git.Git -e', docs: 'https://git-scm.com/download/win' },
			{ label: 'scoop', command: 'scoop install git' },
			{ label: 'Chocolatey', command: 'choco install git -y' }
		);
		if (!mgr) {
			base.unavailableReason = 'No supported package manager found (winget / scoop / choco).';
			return base;
		}
		if (mgr === 'winget') {
			base.autoInstallable = true;
			base.command = ['winget', 'install', '--id', 'Git.Git', '-e', '--accept-source-agreements', '--accept-package-agreements'];
			base.displayCommand = 'winget install --id Git.Git -e';
			return base;
		}
		if (mgr === 'scoop') {
			base.autoInstallable = true;
			base.command = ['scoop', 'install', 'git'];
			base.displayCommand = 'scoop install git';
			return base;
		}
		// choco — requires admin
		const elevated = await isElevated();
		if (!elevated) {
			base.unavailableReason = 'Chocolatey requires Administrator. Run clopen as Administrator or use winget/scoop.';
			return base;
		}
		base.autoInstallable = true;
		base.command = ['choco', 'install', 'git', '-y'];
		base.displayCommand = 'choco install git -y';
		return base;
	}

	// Linux
	const mgr = detectLinuxPkgMgr();
	base.manualInstructions.push(
		{ label: 'apt (Debian/Ubuntu)', command: 'sudo apt update && sudo apt install -y git' },
		{ label: 'dnf (Fedora/RHEL)', command: 'sudo dnf install -y git' },
		{ label: 'pacman (Arch)', command: 'sudo pacman -S --noconfirm git' },
		{ label: 'apk (Alpine)', command: 'sudo apk add git' }
	);
	if (!mgr) {
		base.unavailableReason = 'No supported Linux package manager found.';
		return base;
	}
	const elevated = await isElevated();
	if (!elevated) {
		base.unavailableReason = 'Linux package install requires root. Run the command manually with sudo, or run clopen as root.';
		return base;
	}
	base.autoInstallable = true;
	if (mgr === 'apt') {
		base.shell = { program: 'sh', args: ['-c'] };
		base.command = ['apt-get update && apt-get install -y git'];
		base.displayCommand = 'apt-get update && apt-get install -y git';
	} else if (mgr === 'dnf') {
		base.command = ['dnf', 'install', '-y', 'git'];
		base.displayCommand = 'dnf install -y git';
	} else if (mgr === 'pacman') {
		base.command = ['pacman', '-S', '--noconfirm', 'git'];
		base.displayCommand = 'pacman -S --noconfirm git';
	} else if (mgr === 'apk') {
		base.command = ['apk', 'add', 'git'];
		base.displayCommand = 'apk add git';
	} else if (mgr === 'zypper') {
		base.command = ['zypper', '--non-interactive', 'install', 'git'];
		base.displayCommand = 'zypper --non-interactive install git';
	}
	return base;
}

/**
 * Populate `requiresCurl` and (when the system lacks curl) the pending
 * static-curl download metadata. Returns false when this platform/arch
 * has no pinned asset — caller should mark the recipe unavailable.
 */
function attachCurlRequirement(base: Recipe, toolLabel: string): boolean {
	base.requiresCurl = true;
	if (resolveBinary('curl')) return true;

	const asset = resolveStaticCurlAsset();
	if (!asset) {
		base.unavailableReason = `curl is required by the ${toolLabel} installer, and no static curl is available for ${process.platform}/${process.arch}.`;
		return false;
	}
	base.pendingCurlDownload = {
		version: asset.version,
		url: asset.url,
		sha256: asset.sha256,
		archKey: asset.archKey
	};
	return true;
}

async function resolveClaudeRecipe(): Promise<Recipe> {
	const base: Recipe = {
		tool: 'claude',
		autoInstallable: false,
		missingPrereqs: [],
		manualInstructions: []
	};

	if (process.platform === 'win32') {
		base.autoInstallable = true;
		base.shell = { program: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'] };
		base.command = ['irm https://claude.ai/install.ps1 | iex'];
		base.displayCommand = 'irm https://claude.ai/install.ps1 | iex';
		base.manualInstructions.push({
			label: 'PowerShell',
			command: 'irm https://claude.ai/install.ps1 | iex',
			docs: 'https://docs.claude.com/en/docs/claude-code/overview'
		});
		return base;
	}

	// macOS / Linux
	base.manualInstructions.push({
		label: 'curl + bash',
		command: 'curl -fsSL https://claude.ai/install.sh | bash',
		docs: 'https://docs.claude.com/en/docs/claude-code/overview'
	});
	if (!attachCurlRequirement(base, 'Claude Code')) return base;

	base.autoInstallable = true;
	base.shell = { program: 'bash', args: ['-c'] };
	base.command = ['curl -fsSL https://claude.ai/install.sh | bash'];
	base.displayCommand = 'curl -fsSL https://claude.ai/install.sh | bash';
	return base;
}

async function resolveOpenCodeRecipe(): Promise<Recipe> {
	const base: Recipe = {
		tool: 'opencode',
		autoInstallable: false,
		missingPrereqs: [],
		manualInstructions: [{
			label: 'curl + bash',
			command: 'curl -fsSL https://opencode.ai/install | bash',
			docs: 'https://opencode.ai'
		}]
	};

	if (process.platform === 'win32') {
		base.unavailableReason = 'OpenCode install script is not available on Windows via PowerShell. Use WSL or the manual instructions.';
		return base;
	}

	if (!attachCurlRequirement(base, 'OpenCode')) return base;

	base.autoInstallable = true;
	base.shell = { program: 'bash', args: ['-c'] };
	base.command = ['curl -fsSL https://opencode.ai/install | bash'];
	base.displayCommand = 'curl -fsSL https://opencode.ai/install | bash';
	return base;
}

async function resolveChromeRecipe(): Promise<Recipe> {
	const cacheDir = join(getClopenDir(), 'bin');
	const base: Recipe = {
		tool: 'chrome',
		autoInstallable: true,
		missingPrereqs: [],
		manualInstructions: [{
			label: 'Puppeteer browsers CLI',
			command: `bun x @puppeteer/browsers install chrome@stable --path "${cacheDir}"`,
			docs: 'https://pptr.dev/browsers-api'
		}],
		command: ['bun', 'x', '@puppeteer/browsers', 'install', 'chrome@stable', '--path', cacheDir],
		displayCommand: `bun x @puppeteer/browsers install chrome@stable --path ${cacheDir}`
	};
	return base;
}

/**
 * Resolve the install recipe for a tool on the current platform.
 * Result is platform- and privilege-aware: recipes that would fail
 * non-interactively are marked autoInstallable=false.
 */
export async function resolveRecipe(tool: ToolId): Promise<Recipe> {
	switch (tool) {
		case 'git': return resolveGitRecipe();
		case 'claude': return resolveClaudeRecipe();
		case 'opencode': return resolveOpenCodeRecipe();
		case 'chrome': return resolveChromeRecipe();
	}
}
