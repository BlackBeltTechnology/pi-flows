## Context

The package declares its three `@earendil-works/*` peers at `^0.84.1`. For a `0.x` version, npm's caret narrows to a single minor line: `^0.84.1` == `>=0.84.1 <0.85.0`. The published pi line is now `0.86.1`, so hosts on 0.85.x/0.86.x fail the peer check. The package's own code has never been exercised against 0.85.x or 0.86.x on this machine (highest local install is 0.84.2; the running pi is 0.85.1). The dev-dependencies also sit at `^0.84.1`, so the test/build gate currently validates only the old line.

The imported surface is narrow and stable: `ModelRegistry`, `ModelRuntime`, `Skill`, `loadSkillsFromDir`, and extension-API types from pi-coding-agent; TUI primitives from pi-tui; and the faux provider plus `registerFauxProvider` from pi-ai (test harness only).

## Goals / Non-Goals

**Goals:**
- Widen the three peer ranges so any 0.84/0.85/0.86 (pre-1.0.0) host satisfies them, without dropping 0.84.
- Move the test/build gate onto the newest host line by bumping devDeps to `^0.86.1`.
- Ship the widened compatibility as a minor version (`0.4.0` → `0.5.0`).
- Prove the previously-untested combination is safe via the offline faux gate before publishing.

**Non-Goals:**
- No flow/agent/authoring behavior changes to the package.
- No changes in any consuming repo (a downstream `^0.5.0` bump is a separate change elsewhere).
- Not dropping 0.84 support.

> **Scope update (during apply):** both the HIGH and MED risks below materialized in the gate and required minimal faux-harness adaptations to the 0.86 contract (see resolutions). The "no source changes" expectation held for product/authoring code, not the test harness: `__tests__/faux-skills-injection.test.ts` (read prompt via `getCurrentSystemPrompt`) and `extensions/flow-engine/testing.ts` (`scriptToolThenFinish` param → `JsonObject`).

## Decisions

**D1 — Peer floor `>=0.84.1 <1.0.0` (Option A), not `>=0.85.1 <1.0.0` (Option B).**
Option A keeps existing 0.84 hosts working while admitting 0.85.1+ and 0.86.x; it is the lowest-risk, backward-compatible widening. Option B (drop 0.84) was considered and rejected — there is no need to sever 0.84 hosts, and doing so would be a larger compatibility break for no benefit here.

**D2 — Explicit `>=x <1.0.0` range form, not caret.**
For `0.x` versions the caret pins to one minor line, which is the exact cause of the current failure. The explicit two-sided range is the only form that spans multiple 0.x minors while still excluding the 1.0.0 major.

**D3 — devDeps to `^0.86.1`; version bump `0.4.0` → `0.5.0`.**
The gate should validate against the newest host line the widened range now admits. Widened compatibility with no behavior change is a minor bump. These are release/test mechanics (tasks), not spec requirements.

**D4 — If a 0.85.1/0.86.1 floor is ever needed, use `.1` not `.0` for 0.85.**
0.85.0 shipped broken SDK subpaths (fixed in 0.85.1). Not applicable to Option A's `>=0.84.1` floor, but recorded so any future floor raise avoids `>=0.85.0`.

## Risks / Trade-offs

- **[Faux harness stream contract — HIGH]** 0.86.0 changed provider stream inputs `Context` → `TranscriptContext` (custom providers must use `getCurrentSystemPrompt()`/`getCurrentTools()`). `extensions/flow-engine/testing.ts` delegates to pi-ai's own bundled faux provider (resolved via `compat.js` → `providers/faux.js`) and drives `ModelRuntime.prepareRequest → provider.streamSimple`. The bundled provider upgrades in lockstep, so the exposure is the path resolution + the `fauxAssistantMessage`/`fauxToolCall`/`fauxText`/`registerFauxProvider` export shapes. → **Mitigation:** the `npm ci && npm test` faux gate against `^0.86.1` is the pass/fail signal; a red gate blocks the version bump/publish.
- **[Type tightening — MED]** 0.86.0 restricted `ToolCall.arguments`/`ToolResultMessage.details` to JSON-compatible values, made `ToolResultMessage` conditional, and made `JsonValue` arrays readonly. → **Mitigation:** `npm run build`/typecheck against `^0.86.1` catches any compile break.
- **[Default constrained sampling — LOW]** 0.86.0 turned on strict-prefer JSON-schema sampling for built-in tools by default. → **Mitigation:** faux tests exercise flow-agent tool calls; opt-out (`constrainedSampling: false`) exists if needed.
- **[Range too wide]** `<1.0.0` trusts all pre-1.0.0 lines. → **Trade-off:** accepted; a 1.0.0 major is correctly excluded and would get its own compatibility review.

## Migration Plan

1. Edit `package.json`: 3 peer ranges → `>=0.84.1 <1.0.0`; 3 devDeps → `^0.86.1`; `version` → `0.5.0`.
2. `npm ci` (pulls 0.86.1 fresh from the registry — not cached locally).
3. Run the offline faux gate: `npm test` (capture to a log) and `npm run build`.
4. If green → publish `0.5.0`. If red → do not bump/publish; triage against the HIGH/MED risks above.

Rollback: revert the `package.json` edit; the published `0.4.0` is unaffected. `0.5.0`, once published, is immutable — a fix would be `0.5.1`.

## Open Questions

None. Floor (Option A) and spec home (`package-manifest`) are decided.
