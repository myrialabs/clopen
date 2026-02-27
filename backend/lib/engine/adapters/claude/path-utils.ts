import { resolve } from 'path';

export function normalizePath(projectPath: string): string {
  let normalizedProjectPath = projectPath;

  if (process.platform === 'win32') {
    if (!projectPath.match(/^[A-Za-z]:\\/)) {
      if (projectPath.startsWith('\\')) {
        const currentDrive = process.cwd().substring(0, 2);
        normalizedProjectPath = currentDrive + projectPath;
      } else {
        normalizedProjectPath = resolve(projectPath);
      }
    }

    normalizedProjectPath = normalizedProjectPath.replace(/\//g, '\\');
  }

  return normalizedProjectPath;
}

export function changeWorkingDirectory(targetPath: string): string {
  const originalCwd = process.cwd();

  try {
    process.chdir(targetPath);
    return originalCwd;
  } catch (error) {
    throw new Error(`Cannot change working directory to ${targetPath}: ${error}`);
  }
}

export function restoreWorkingDirectory(originalCwd: string): void {
  try {
    process.chdir(originalCwd);
  } catch (error) {
  }
}
