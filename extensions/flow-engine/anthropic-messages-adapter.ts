// ---------------------------------------------------------------------------
// Adapter: run the anthropic-messages bridge against spawned subagent sessions.
//
// WHY
//   Spawned flow agent sessions build their own independent AgentSession with
//   its own extension stack; the main session's extensions do not reach them.
//   To get the same anthropic-messages payload/response transforms (mcp__
//   prefixing of custom tools, inbound response translation, system-prompt
//   compat shims) we run the bridge package's default export against each
//   subagent's pi API at spawn time. This is the reliable IN-PROCESS path;
//   it does not depend on any dashboard plugin emitting an event.
//
// PACKAGE NAME
//   The bridge published to npm as `@blackbelt-technology/pi-anthropic-messages`
//   (rescoped from the legacy `@pi/anthropic-messages`). We try the new name
//   first, then the legacy name.
//
// RESOLUTION
//   The bridge is usually installed via `pi install` into ~/.pi/agent/npm,
//   which is NOT on Node's node_modules walk from this package. A bare
//   `import()` therefore throws MODULE_NOT_FOUND. So after the bare attempts
//   we fall back to resolving the package's absolute entry from pi's own
//   install location (~/.pi/agent/npm/node_modules + <cwd>/.pi/npm) and
//   importing that path directly. The published package ships compiled JS
//   (dist/index.js), so a plain import() of the resolved entry works (a raw
//   .ts entry under node_modules would fail type-stripping).
//
// Optional dependency: if the bridge is not installed anywhere, every strategy
// fails and this file is a silent no-op.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const PKG_NAMES = [
	"@blackbelt-technology/pi-anthropic-messages",
	"@pi/anthropic-messages",
] as const;

/** Candidate node_modules roots where `pi install` drops packages. */
function piModuleRoots(): string[] {
	return [
		join(homedir(), ".pi", "agent", "npm", "node_modules"),
		join(process.cwd(), ".pi", "npm", "node_modules"),
	];
}

/**
 * Resolve a package name to an absolute, importable entry file by reading its
 * package.json from pi's install roots. Prefers `exports["."]` (import/default)
 * → `main` → `index.js`. Returns null if not found.
 */
function resolvePiPackageEntry(name: string): string | null {
	for (const root of piModuleRoots()) {
		const dir = join(root, ...name.split("/"));
		const pjPath = join(dir, "package.json");
		if (!existsSync(pjPath)) continue;
		try {
			const pj = JSON.parse(readFileSync(pjPath, "utf-8"));
			let rel: string | undefined;
			const exp = pj.exports?.["."] ?? pj.exports;
			if (typeof exp === "string") rel = exp;
			else if (exp && typeof exp === "object")
				rel = exp.import ?? exp.default ?? exp.node;
			const relPath: string = rel ?? pj.main ?? "index.js";
			const entry = join(dir, relPath);
			if (existsSync(entry)) return entry;
		} catch {
			/* malformed package.json — try next root */
		}
	}
	return null;
}

async function loadBridge(): Promise<((pi: unknown) => unknown) | null> {
	// 1) Bare specifiers (works when resolvable from this package's tree).
	for (const name of PKG_NAMES) {
		try {
			// @ts-ignore — optional peer; resolved at runtime.
			const mod = await import(name);
			if (typeof mod?.default === "function") return mod.default;
		} catch {
			/* not resolvable as a bare specifier — fall through */
		}
	}
	// 2) Absolute entry resolved from pi's install location.
	for (const name of PKG_NAMES) {
		const entry = resolvePiPackageEntry(name);
		if (!entry) continue;
		try {
			const mod = await import(pathToFileURL(entry).href);
			if (typeof mod?.default === "function") return mod.default;
		} catch {
			/* entry present but failed to import — try next */
		}
	}
	return null;
}

export const anthropicMessagesAgentFactory: ExtensionFactory = async (pi) => {
	try {
		const bridge = await loadBridge();
		if (bridge) await bridge(pi);
		// Not installed anywhere → no-op (subagents run untransformed).
	} catch {
		/* never throw from the adapter — subagent must still run */
	}
};
