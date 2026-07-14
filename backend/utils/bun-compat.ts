/**
 * Bun compatibility shims — applied as a side effect at process startup.
 *
 * `node:v8` `startupSnapshot.isBuildingSnapshot()` is not implemented in Bun
 * (calling it throws `ERR_NOT_IMPLEMENTED`). `bson` >= 7.3.0 invokes it inside a
 * module-level `static {}` block, so importing `mongodb` crashes the process at
 * load time on Bun — before Clopen can even start.
 *
 * We cannot reliably pin the transitive `bson` for end users: they install via
 * `bun add -g @myrialabs/clopen`, where Clopen is a dependency rather than the
 * root package, so its `overrides`/exact pins are ignored and Bun re-resolves
 * `mongodb`'s `bson: "^7.2.0"` to the newest (broken) version. Instead we
 * neutralize the missing API by replacing the throwing stub with a no-op that
 * reports "not building a snapshot" — always true for a normally-running
 * process, so `bson` skips its snapshot branch and loads cleanly.
 *
 * This file MUST be loaded via Bun's `--preload` / `bunfig.toml preload`, NOT a
 * plain `import`. Bun does not guarantee that an earlier ESM side-effect import
 * runs before a later CJS import is evaluated, so `import './bun-compat'` at the
 * top of an entry still lets `mongodb`/`bson` load (and crash) first. `preload`
 * is the only mechanism that reliably runs before the entry's import graph.
 */

if (typeof globalThis.Bun !== 'undefined') {
	const v8 = (process as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule?.('v8') as
		| { startupSnapshot?: { isBuildingSnapshot?: () => boolean } }
		| undefined;

	if (v8?.startupSnapshot && typeof v8.startupSnapshot.isBuildingSnapshot === 'function') {
		try {
			v8.startupSnapshot.isBuildingSnapshot = () => false;
		} catch {
			// Property is non-writable in this runtime — best effort, nothing else to do.
		}
	}
}
