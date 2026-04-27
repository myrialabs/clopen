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

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isElevated } from '$backend/utils/privilege';
import { getClopenDir } from '$backend/utils/paths';
import { resolveBinary, resolveBinaryWithRefresh } from '$backend/utils/cli';
import { resolveStaticCurlAsset } from '$backend/utils/static-curl';

export type ToolId = 'git' | 'claude' | 'opencode' | 'copilot' | 'chrome' | 'cloudflared';

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
// Chrome detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the Chrome for Testing executable path under ~/.clopen/bin using
 * the @puppeteer/browsers cache layout: <cache>/chrome/<platform>-<buildId>/<archive>/<binary>.
 * Only macOS and Windows install Chrome this way — on Linux we install
 * Google Chrome via the distro package manager and skip this scan.
 */
export function resolveClopenChromePath(): string | null {
	if (process.platform !== 'darwin' && process.platform !== 'win32') return null;

	const cacheDir = join(getClopenDir(), 'bin', 'chrome');
	if (!existsSync(cacheDir)) return null;

	try {
		const entries = readdirSync(cacheDir);
		for (const entry of entries) {
			const buildDir = join(cacheDir, entry);
			if (process.platform === 'darwin') {
				const macDirs = ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac'];
				for (const dir of macDirs) {
					const candidate = join(
						buildDir, dir,
						'Google Chrome for Testing.app',
						'Contents', 'MacOS', 'Google Chrome for Testing'
					);
					if (existsSync(candidate)) return candidate;
				}
			} else {
				const winDirs = ['chrome-win64', 'chrome-win'];
				for (const dir of winDirs) {
					const candidate = join(buildDir, dir, 'chrome.exe');
					if (existsSync(candidate)) return candidate;
				}
			}
		}
	} catch {
		// Fall through
	}
	return null;
}

function detectSystemChrome(): string | null {
	if (process.platform === 'darwin') {
		const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
		return existsSync(p) ? p : null;
	}
	if (process.platform === 'win32') {
		const paths = [
			'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
			'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
		];
		for (const p of paths) if (existsSync(p)) return p;
		return resolveBinary('chrome');
	}
	// Linux: Google Chrome only (installed via apt/dnf/zypper from dl.google.com).
	const chromePaths = [
		'/opt/google/chrome/chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/google-chrome'
	];
	for (const p of chromePaths) if (existsSync(p)) return p;
	return resolveBinary('google-chrome-stable') ?? resolveBinary('google-chrome');
}

/**
 * Preferred Chrome executable path for puppeteer. Clopen-managed install
 * (macOS/Windows via @puppeteer/browsers → Chrome for Testing) wins over
 * system Google Chrome so the bundled version stays consistent; on Linux
 * only the system Google Chrome path is used.
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
		const source = resolveClopenChromePath() ? 'clopen' : resolved;
		return { tool, installed: true, version, source };
	}

	const resolved = await resolveBinaryWithRefresh(tool);
	if (!resolved) return { tool, installed: false, version: null, source: null };
	const version = await runVersion(resolved);
	if (!version) return { tool, installed: false, version: null, source: null };

	// Cloudflared: tag binaries under ~/.clopen/bin as "clopen"-managed so the
	// UI distinguishes System Tools installs from system-wide ones.
	if (tool === 'cloudflared') {
		const clopenBinDir = join(getClopenDir(), 'bin');
		if (resolved.startsWith(clopenBinDir)) {
			return { tool, installed: true, version, source: 'clopen' };
		}
	}

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

async function resolveCopilotRecipe(): Promise<Recipe> {
	const base: Recipe = {
		tool: 'copilot',
		autoInstallable: true,
		missingPrereqs: [],
		manualInstructions: [{
			label: 'bun',
			command: 'bun add -g @github/copilot',
			docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli'
		}],
		command: ['bun', 'add', '-g', '@github/copilot'],
		displayCommand: 'bun add -g @github/copilot'
	};
	return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome recipe — Puppeteer download (macOS/Windows) or Google Chrome (Linux)
// ─────────────────────────────────────────────────────────────────────────────

const PPTR_CHROME_DOCS = 'https://pptr.dev/browsers-api';
const CHROME_LINUX_DOCS = 'https://www.google.com/chrome/';

// Google Chrome Linux package URLs. Google only publishes Linux x86_64
// .deb (apt) and .rpm (dnf/zypper) — other distros / arm64 surface manual
// instructions.
const GOOGLE_CHROME_DEB_URL = 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';
const GOOGLE_CHROME_RPM_URL = 'https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm';

async function resolveChromeRecipe(): Promise<Recipe> {
	const cacheDir = join(getClopenDir(), 'bin');
	const pptrArgs = ['bun', 'x', '@puppeteer/browsers', 'install', 'chrome@stable', '--path', cacheDir];
	const pptrDisplay = `bun x @puppeteer/browsers install chrome@stable --path "${cacheDir}"`;

	// macOS / Windows: Puppeteer downloads Chrome for Testing, self-contained.
	if (process.platform === 'darwin' || process.platform === 'win32') {
		return {
			tool: 'chrome',
			autoInstallable: true,
			missingPrereqs: [],
			manualInstructions: [{
				label: 'Puppeteer browsers CLI',
				command: pptrDisplay,
				docs: PPTR_CHROME_DOCS
			}],
			command: pptrArgs,
			displayCommand: pptrDisplay
		};
	}

	// Linux: Google Chrome deb/rpm for x86_64 (apt/dnf/zypper). Other
	// distros / arm64 are marked non-auto-installable with manual steps.
	return resolveLinuxChromeRecipe();
}

interface LinuxChromeStrategy {
	pkgMgrLabel: string;
	/** Argv-form command to spawn (sh -c <string>). */
	installCommand: string;
	/** User-facing display command (with sudo prefix if interactive). */
	manualCommand: string;
	/** Whether this strategy shells out to curl (for static-curl fallback). */
	requiresCurl?: boolean;
	/** Extra env to inject into the spawn. */
	env?: Record<string, string>;
}

async function resolveLinuxChromeRecipe(): Promise<Recipe> {
	const mgr = detectLinuxPkgMgr();
	const arch = process.arch;

	const manual: ManualInstruction[] = [];
	const strategy = pickLinuxChromeStrategy(mgr, arch);

	if (strategy) {
		manual.push({
			label: `${strategy.pkgMgrLabel} (recommended)`,
			command: strategy.manualCommand,
			docs: CHROME_LINUX_DOCS
		});
	}

	const base: Recipe = {
		tool: 'chrome',
		autoInstallable: false,
		missingPrereqs: [],
		manualInstructions: manual
	};

	if (!strategy) {
		base.unavailableReason = arch !== 'x64'
			? `Google Chrome is only published for Linux x86_64. No Chrome build exists for ${arch}. Download Chrome manually from google.com/chrome.`
			: `Google Chrome is only available via apt, dnf, or zypper on Linux${mgr ? ` (this system uses ${mgr})` : ' — no supported package manager was detected'}. Download Chrome manually from google.com/chrome.`;
		return base;
	}

	if (strategy.requiresCurl && !attachCurlRequirement(base, 'Google Chrome')) {
		return base;
	}

	const elevated = await isElevated();
	if (!elevated) {
		base.unavailableReason = `Installing Google Chrome via ${strategy.pkgMgrLabel} requires root. Run clopen as root, or install Chrome manually with the command below and retry.`;
		return base;
	}

	base.autoInstallable = true;
	base.shell = { program: 'sh', args: ['-c'] };
	base.command = [strategy.installCommand];
	base.displayCommand = strategy.manualCommand;
	if (strategy.env) base.env = strategy.env;
	return base;
}

function pickLinuxChromeStrategy(
	mgr: LinuxPkgMgr | null,
	arch: string
): LinuxChromeStrategy | null {
	// Google only publishes Linux Chrome for x86_64.
	if (arch !== 'x64') return null;

	if (mgr === 'apt') {
		// Download + install the .deb from dl.google.com. apt-get install with
		// a local deb path auto-resolves dependencies (libatk, libnss3, etc.)
		// from the distro repos. The postinst adds Google's apt source for
		// future updates.
		const cmd =
			'apt-get update && apt-get install -y curl ca-certificates && ' +
			`curl -fsSL -o /tmp/google-chrome-stable.deb ${GOOGLE_CHROME_DEB_URL} && ` +
			'apt-get install -y /tmp/google-chrome-stable.deb && ' +
			'rm -f /tmp/google-chrome-stable.deb';
		return {
			pkgMgrLabel: 'apt',
			installCommand: cmd,
			manualCommand:
				`sudo apt-get update && sudo apt-get install -y curl ca-certificates && ` +
				`curl -fsSL -o /tmp/google-chrome-stable.deb ${GOOGLE_CHROME_DEB_URL} && ` +
				`sudo apt-get install -y /tmp/google-chrome-stable.deb`,
			requiresCurl: true,
			env: { DEBIAN_FRONTEND: 'noninteractive' }
		};
	}
	if (mgr === 'dnf') {
		return {
			pkgMgrLabel: 'dnf',
			installCommand: `dnf install -y ${GOOGLE_CHROME_RPM_URL}`,
			manualCommand: `sudo dnf install -y ${GOOGLE_CHROME_RPM_URL}`
		};
	}
	if (mgr === 'zypper') {
		return {
			pkgMgrLabel: 'zypper',
			installCommand: `zypper --non-interactive --gpg-auto-import-keys install ${GOOGLE_CHROME_RPM_URL}`,
			manualCommand: `sudo zypper install ${GOOGLE_CHROME_RPM_URL}`
		};
	}
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflared recipe — downloads the Cloudflare-signed binary into ~/.clopen/bin
// ─────────────────────────────────────────────────────────────────────────────

const CLOUDFLARED_RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const CLOUDFLARED_DOCS = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

const CLOUDFLARED_LINUX_ARCH: Record<string, string> = {
	x64: 'amd64',
	arm64: 'arm64',
	arm: 'arm',
	ia32: '386'
};

async function resolveCloudflaredRecipe(): Promise<Recipe> {
	const base: Recipe = {
		tool: 'cloudflared',
		autoInstallable: false,
		missingPrereqs: [],
		manualInstructions: []
	};

	const binDir = join(getClopenDir(), 'bin');

	if (process.platform === 'darwin') {
		const archKey = process.arch === 'arm64' ? 'arm64' : 'amd64';
		const file = `cloudflared-darwin-${archKey}.tgz`;
		const url = `${CLOUDFLARED_RELEASE_BASE}/${file}`;
		const cmd =
			`mkdir -p "${binDir}" && ` +
			`curl -fsSL -o "${binDir}/${file}" "${url}" && ` +
			`tar -xzf "${binDir}/${file}" -C "${binDir}" && ` +
			`rm -f "${binDir}/${file}" && ` +
			`chmod +x "${binDir}/cloudflared"`;

		base.manualInstructions.push({
			label: 'curl + tar',
			command: cmd,
			docs: CLOUDFLARED_DOCS
		});
		if (!attachCurlRequirement(base, 'Cloudflared')) return base;
		base.autoInstallable = true;
		base.shell = { program: 'bash', args: ['-c'] };
		base.command = [cmd];
		base.displayCommand = cmd;
		return base;
	}

	if (process.platform === 'linux') {
		const archKey = CLOUDFLARED_LINUX_ARCH[process.arch];
		if (!archKey) {
			base.unavailableReason = `Cloudflared has no published Linux build for ${process.arch}.`;
			return base;
		}
		const file = `cloudflared-linux-${archKey}`;
		const url = `${CLOUDFLARED_RELEASE_BASE}/${file}`;
		const cmd =
			`mkdir -p "${binDir}" && ` +
			`curl -fsSL -o "${binDir}/cloudflared" "${url}" && ` +
			`chmod +x "${binDir}/cloudflared"`;

		base.manualInstructions.push({
			label: 'curl',
			command: cmd,
			docs: CLOUDFLARED_DOCS
		});
		if (!attachCurlRequirement(base, 'Cloudflared')) return base;
		base.autoInstallable = true;
		base.shell = { program: 'bash', args: ['-c'] };
		base.command = [cmd];
		base.displayCommand = cmd;
		return base;
	}

	if (process.platform === 'win32') {
		const archKey = process.arch === 'ia32' ? '386' : 'amd64';
		const file = `cloudflared-windows-${archKey}.exe`;
		const url = `${CLOUDFLARED_RELEASE_BASE}/${file}`;
		const psCmd =
			`New-Item -ItemType Directory -Path "${binDir}" -Force | Out-Null; ` +
			`Invoke-WebRequest -Uri "${url}" -OutFile "${binDir}\\cloudflared.exe"`;

		base.manualInstructions.push({
			label: 'PowerShell',
			command: psCmd,
			docs: CLOUDFLARED_DOCS
		});
		base.autoInstallable = true;
		base.shell = { program: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'] };
		base.command = [psCmd];
		base.displayCommand = psCmd;
		return base;
	}

	base.unavailableReason = `Unsupported platform: ${process.platform}`;
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
		case 'copilot': return resolveCopilotRecipe();
		case 'chrome': return resolveChromeRecipe();
		case 'cloudflared': return resolveCloudflaredRecipe();
	}
}
