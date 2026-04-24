/**
 * System Tool Install Recipes
 *
 * Data-driven registry of install commands for system tools that clopen
 * depends on (Git, Claude Code, OpenCode, Chromium for puppeteer). Each
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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isElevated } from '$backend/utils/privilege';
import { getClopenDir } from '$backend/utils/paths';
import { resolveBinary, resolveBinaryWithRefresh } from '$backend/utils/cli';
import { resolveStaticCurlAsset } from '$backend/utils/static-curl';

export type ToolId = 'git' | 'claude' | 'opencode' | 'chromium';

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
// Chromium detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the Chromium executable path under ~/.clopen/bin using the
 * @puppeteer/browsers cache layout: <cache>/chromium/<platform>-<buildId>/<archive>/<binary>.
 * Only macOS and Windows install via @puppeteer/browsers — on Linux we
 * delegate to the distro package manager and skip this scan.
 */
export function resolveClopenChromiumPath(): string | null {
	if (process.platform !== 'darwin' && process.platform !== 'win32') return null;

	const cacheDir = join(getClopenDir(), 'bin', 'chromium');
	if (!existsSync(cacheDir)) return null;

	try {
		const entries = readdirSync(cacheDir);
		for (const entry of entries) {
			const buildDir = join(cacheDir, entry);
			let candidate: string;
			if (process.platform === 'darwin') {
				candidate = join(buildDir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
				if (existsSync(candidate)) return candidate;
			} else {
				candidate = join(buildDir, 'chrome-win', 'chrome.exe');
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {
		// Fall through
	}
	return null;
}

function detectSystemChromium(): string | null {
	if (process.platform === 'darwin') {
		const paths = ['/Applications/Chromium.app/Contents/MacOS/Chromium'];
		for (const p of paths) if (existsSync(p)) return p;
		return null;
	}
	if (process.platform === 'win32') {
		// Chromium has no canonical Windows install location; rely on PATH.
		return resolveBinary('chromium');
	}
	// Linux: distro package + snap (Ubuntu).
	const snapPath = '/snap/bin/chromium';
	if (existsSync(snapPath)) return snapPath;
	return resolveBinary('chromium') ?? resolveBinary('chromium-browser');
}

/**
 * Preferred Chromium executable path for puppeteer. Clopen-managed install
 * (macOS/Windows via @puppeteer/browsers) wins over system Chromium so the
 * bundled version stays consistent; on Linux only the system path is used.
 */
export function getChromiumExecutablePath(): string | null {
	return resolveClopenChromiumPath() ?? detectSystemChromium();
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
	if (tool === 'chromium') {
		const resolved = getChromiumExecutablePath();
		if (!resolved) return { tool, installed: false, version: null, source: null };
		const version = await runVersion(resolved);
		const source = resolveClopenChromiumPath() ? 'clopen' : 'system';
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

// ─────────────────────────────────────────────────────────────────────────────
// Linux distro detection (apt sub-flavour: Debian vs Ubuntu)
// ─────────────────────────────────────────────────────────────────────────────

interface LinuxDistro {
	id: string;
	idLike: string[];
}

function readLinuxDistro(): LinuxDistro | null {
	try {
		const text = readFileSync('/etc/os-release', 'utf8');
		const fields: Record<string, string> = {};
		for (const line of text.split('\n')) {
			const eq = line.indexOf('=');
			if (eq < 0) continue;
			const key = line.slice(0, eq).trim();
			let value = line.slice(eq + 1).trim();
			if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
			fields[key] = value;
		}
		return {
			id: (fields['ID'] ?? '').toLowerCase(),
			idLike: (fields['ID_LIKE'] ?? '').toLowerCase().split(/\s+/).filter(Boolean)
		};
	} catch {
		return null;
	}
}

function isUbuntuLike(distro: LinuxDistro | null): boolean {
	if (!distro) return false;
	if (distro.id === 'ubuntu') return true;
	return distro.idLike.includes('ubuntu');
}

// ─────────────────────────────────────────────────────────────────────────────
// Chromium recipe — Puppeteer download (macOS/Windows) or distro pkg (Linux)
// ─────────────────────────────────────────────────────────────────────────────

const PPTR_CHROMIUM_DOCS = 'https://pptr.dev/browsers-api';
const PPTR_LINUX_DOCS = 'https://pptr.dev/troubleshooting#chrome-doesnt-launch-on-linux';

async function resolveChromiumRecipe(): Promise<Recipe> {
	const cacheDir = join(getClopenDir(), 'bin');
	const pptrArgs = ['bun', 'x', '@puppeteer/browsers', 'install', 'chromium@latest', '--path', cacheDir];
	const pptrDisplay = `bun x @puppeteer/browsers install chromium@latest --path "${cacheDir}"`;

	// macOS / Windows: Puppeteer download is self-contained.
	if (process.platform === 'darwin' || process.platform === 'win32') {
		return {
			tool: 'chromium',
			autoInstallable: true,
			missingPrereqs: [],
			manualInstructions: [{
				label: 'Puppeteer browsers CLI',
				command: pptrDisplay,
				docs: PPTR_CHROMIUM_DOCS
			}],
			command: pptrArgs,
			displayCommand: pptrDisplay
		};
	}

	// Linux: delegate to distro package manager so deps auto-resolve.
	return resolveLinuxChromiumRecipe();
}

interface LinuxChromiumStrategy {
	pkgMgrLabel: string;
	/** Argv-form command to spawn (sh -c <string>). */
	installCommand: string;
	/** User-facing display command (with sudo prefix if interactive). */
	manualCommand: string;
	/** Extra env to inject into the spawn. */
	env?: Record<string, string>;
}

async function resolveLinuxChromiumRecipe(): Promise<Recipe> {
	const distro = readLinuxDistro();
	const ubuntuLike = isUbuntuLike(distro);
	const mgr = detectLinuxPkgMgr();

	const manual: ManualInstruction[] = [];

	// Always surface the recommended manual command(s) for this platform.
	const strategy = pickLinuxChromiumStrategy(mgr, ubuntuLike);

	if (strategy) {
		manual.push({
			label: `${strategy.pkgMgrLabel} (recommended)`,
			command: strategy.manualCommand,
			docs: PPTR_LINUX_DOCS
		});
	}

	// Ubuntu users may want a non-snap fallback; mention common alternatives.
	if (ubuntuLike) {
		manual.push({
			label: 'Ubuntu — install snapd first if missing',
			command: 'sudo apt-get update && sudo apt-get install -y snapd && sudo snap install chromium',
			docs: 'https://snapcraft.io/chromium'
		});
	}

	const base: Recipe = {
		tool: 'chromium',
		autoInstallable: false,
		missingPrereqs: [],
		manualInstructions: manual
	};

	if (!mgr || !strategy) {
		base.unavailableReason = mgr
			? `No Chromium install strategy is mapped for ${mgr} on this distro. Install Chromium manually with your package manager.`
			: 'No supported Linux package manager found (apt / dnf / pacman / apk / zypper). Install Chromium manually.';
		return base;
	}

	if (ubuntuLike && !resolveBinary('snap')) {
		base.unavailableReason = 'Ubuntu Chromium is distributed as a snap, but snapd is not installed on this system. Install snapd first (`sudo apt-get install -y snapd`), then retry — or use the manual instructions below.';
		return base;
	}

	const elevated = await isElevated();
	if (!elevated) {
		base.unavailableReason = `Installing Chromium via ${strategy.pkgMgrLabel} requires root. Run clopen as root, or install Chromium manually with the command below and retry.`;
		return base;
	}

	base.autoInstallable = true;
	base.shell = { program: 'sh', args: ['-c'] };
	base.command = [strategy.installCommand];
	base.displayCommand = strategy.manualCommand;
	if (strategy.env) base.env = strategy.env;
	return base;
}

function pickLinuxChromiumStrategy(
	mgr: LinuxPkgMgr | null,
	ubuntuLike: boolean
): LinuxChromiumStrategy | null {
	if (mgr === 'apt' && ubuntuLike) {
		// Ubuntu's `chromium` / `chromium-browser` deb is a snap shim. Use snap directly.
		return {
			pkgMgrLabel: 'snap',
			installCommand: 'snap install chromium',
			manualCommand: 'sudo snap install chromium'
		};
	}
	if (mgr === 'apt') {
		return {
			pkgMgrLabel: 'apt',
			installCommand: 'apt-get update && apt-get install -y chromium',
			manualCommand: 'sudo apt-get update && sudo apt-get install -y chromium',
			env: { DEBIAN_FRONTEND: 'noninteractive' }
		};
	}
	if (mgr === 'dnf') {
		return {
			pkgMgrLabel: 'dnf',
			installCommand: 'dnf install -y chromium',
			manualCommand: 'sudo dnf install -y chromium'
		};
	}
	if (mgr === 'pacman') {
		return {
			pkgMgrLabel: 'pacman',
			installCommand: 'pacman -S --noconfirm chromium',
			manualCommand: 'sudo pacman -S --noconfirm chromium'
		};
	}
	if (mgr === 'apk') {
		return {
			pkgMgrLabel: 'apk',
			installCommand: 'apk add --no-cache chromium',
			manualCommand: 'sudo apk add --no-cache chromium'
		};
	}
	if (mgr === 'zypper') {
		return {
			pkgMgrLabel: 'zypper',
			installCommand: 'zypper --non-interactive install chromium',
			manualCommand: 'sudo zypper install chromium'
		};
	}
	return null;
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
		case 'chromium': return resolveChromiumRecipe();
	}
}
