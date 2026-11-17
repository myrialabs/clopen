#!/usr/bin/env bun
/**
 * The dev frontend (Vite) as the dev runner supervises it.
 *
 * Vite cannot be told to watch its supervisor the way the backend does, so it
 * runs under this small guard: if the dev runner disappears without stopping
 * it (killed outright — `bun run` kills its child on a second Ctrl+C), Vite is
 * stopped instead of running on unowned with its port held. Vite shares this
 * process's group, so every signal the supervisor sends the group reaches it
 * directly; the guard only waits for it and exits with its code.
 */

import { watchSupervisor } from '../shared/utils/process-supervisor';

let vite: ReturnType<typeof Bun.spawn> | null = null;

// Before spawning: the variable must not reach Vite's environment.
watchSupervisor(() => {
	vite?.kill('SIGTERM');
	setTimeout(() => vite?.kill('SIGKILL'), 5000).unref();
});

vite = Bun.spawn(['bunx', 'vite', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });

// Group signals reach Vite itself; this process stays until Vite is gone.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {});

const code = await vite.exited;
process.exit(code ?? 1);
