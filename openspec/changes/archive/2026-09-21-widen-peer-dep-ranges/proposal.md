## Why

The package pins its three `@earendil-works/*` peer dependencies at `^0.84.1`, which resolves to `>=0.84.1 <0.85.0` and therefore refuses hosts running pi 0.85.x or 0.86.x. The current published pi line is 0.86.1, so consumers on a modern pi cannot satisfy the peer range and installation fails. The compatibility ceiling must widen to admit the newer host line while keeping existing 0.84 hosts working.

## What Changes

- Widen the three peer-dependency ranges from `^0.84.1` to `>=0.84.1 <1.0.0` (keeps 0.84 working, admits 0.85.1+ and 0.86.x) — the consumer-facing compatibility contract:
  - `@earendil-works/pi-ai`
  - `@earendil-works/pi-coding-agent`
  - `@earendil-works/pi-tui`
- Bump the three matching dev-dependencies to `^0.86.1` so the test/build gate validates against the newest host line (release/test mechanics — captured in tasks, not a spec requirement).
- Bump the package version `0.4.0` → `0.5.0` (minor: widened compatibility) — release mechanics, captured in tasks.
- Prove the previously-untested combination (this package's code has never run against pi-ai 0.85.x/0.86.x here) is safe via the offline faux gate: `npm ci && npm test && npm run build` against the bumped devDeps.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `package-manifest`: add a requirement that the manifest SHALL declare supported peer versions for the three `@earendil-works/*` packages as `>=0.84.1 <1.0.0`, so a consumer on any 0.84/0.85/0.86 host (up to but excluding 1.0.0) satisfies the peer range.

## Impact

- **Manifest:** `package.json` — `peerDependencies` (3 ranges widened), `devDependencies` (3 ranges bumped to `^0.86.1`), `version` (`0.4.0` → `0.5.0`).
- **Product/authoring surface unchanged; two faux-harness adaptations required (added during apply, gate-driven).** No flow/agent/authoring behavior changes. The gate surfaced two 0.86 breaking-change hits that needed test-harness edits: (1) `__tests__/faux-skills-injection.test.ts` — read the system prompt via `getCurrentSystemPrompt(context.messages)` instead of the removed `context.systemPrompt` field (test-only); (2) `extensions/flow-engine/testing.ts` — `scriptToolThenFinish` param `Record<string,unknown>` → `JsonObject` to match the tightened `ToolCall.arguments` (public `./testing` API param type, behavior-preserving). The package still imports only stable surfaces (`ModelRegistry`/`ModelRuntime`/`Skill`/`loadSkillsFromDir`/extension-API types, TUI primitives, faux provider + `registerFauxProvider`).
- **Lockfile regenerated.** `package-lock.json` was regenerated via `npm install` (the `^0.86.1` devDep bump requires it before `npm ci`); the whole 0.86.1 closure moved forward (pi-ai/pca/pi-tui/pi-telemetry + transitive AWS/Anthropic/Google SDK bumps).
- **Compatibility risk (verified against the 0.86.0 breaking changes):**
  - The faux test harness (`extensions/flow-engine/testing.ts`, spine of the `faux-*` suite) delegates to pi-ai's own bundled faux provider via a nested-copy path resolution (`compat.js` → `providers/faux.js`) and drives `ModelRuntime.prepareRequest → provider.streamSimple`. 0.86.0 changed provider stream inputs from `Context` to `TranscriptContext`; the bundled faux provider upgrades in lockstep, but the path-resolution and the `fauxAssistantMessage`/`fauxToolCall`/`fauxText`/`registerFauxProvider` export shapes are the surfaces to re-verify. **This is the gate.**
  - 0.86.0 tightened `ToolCall.arguments`/`ToolResultMessage.details` to JSON-compatible values, made `ToolResultMessage` a conditional type, and made `JsonValue` arrays readonly — could surface as `tsc`/build errors even if runtime is fine.
- **Downstream (out of scope here):** a consumer depending on this package at `^0.4.0` will not auto-pick `0.5.0` and must widen its own dependency range; that is a separate change in the consuming repo.
