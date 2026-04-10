export function getBackendOS(): 'windows' | 'macos' | 'linux' {
	switch (process.platform) {
		case 'win32': return 'windows';
		case 'darwin': return 'macos';
		default: return 'linux';
	}
}