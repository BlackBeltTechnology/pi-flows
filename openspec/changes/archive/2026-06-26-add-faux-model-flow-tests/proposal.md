# Add faux-model flow tests

## Why

Every current test in `__tests__/` exercises the seams *around* the agent loop — model resolution, code-step execution, parsers, wiring, and the guard via static lint — but **nothing drives the real `createAgentSession` loop**. The finish latch, finish-retry stop-gate, tool dispatch through the guard, abort-mid-stream, and soft-fail routing are all validated by unit stubs, not by a session that actually streams turns. `TODO.md` flags this gap explicitly under MUST: "Flow tests / faux model tests."

The `pi-ai` `fauxProvider` closes the gap: it is a scripted-response provider (zero network, deterministic) whose `Model` object is a first-class registry citizen, so it can run a genuine `spawnAgent`/`runFlow` execution with no real LLM.

## What Changes

- Add a reusable test harness (`__tests__/faux-harness.ts`) exposing helpers to build a faux provider + a `modelRegistry` stub + a `spawnAgent` invocation, plus response-scripting shortcuts (finish, tool-call, error, abort).
- Add `spawnAgent`-level tests that run the real session loop against scripted faux turns:
  - finish happy path (schema-valid finish → success + output wiring),
  - finish retry + first-correct-wins latch (bad finish, then good finish),
  - tool dispatch through the guard (authorized tool call, then finish),
  - unauthorized-tool block (guard rejects a tool not in `agent.tools`),
  - abort mid-stream (low `tokensPerSecond` + signal abort → aborted result),
  - soft-fail routing (`stopReason: "error"` → `node-failure-model` outcome).
- Add a small number of `runFlow` smoke tests: a 2-step `${{result.x.out}}` wiring chain and a fork, using one faux model id per agent role as the discriminator.
- Add one explicit `anthropic-messages` variant case to cover the `mcp__flows__` tool-name prefix path (invisible to a default-`api` faux model).

This is **additive** — no production code behavior changes; only test infrastructure and test suites are added.

## Capabilities

### New Capabilities
- `faux-model-testing`: A test-infrastructure contract for driving real `spawnAgent`/`runFlow` executions with the `pi-ai` faux provider — defines the harness surface, the scripted-response model, the model-id discriminator for multi-agent flows, and the minimum capability coverage the faux suites must exercise.

### Modified Capabilities
<!-- None — this change adds test coverage only; no existing spec requirements change. -->

## Impact

- **Affected specs:** new `faux-model-testing` capability.
- **Affected code:** `__tests__/` only (new harness + new suites). No `extensions/` production changes.
- **Affected dependencies:** relies on `fauxProvider`, `fauxAssistantMessage`, `fauxToolCall` from `@earendil-works/pi-ai` (already a transitive peer via `pi-coding-agent`).
- **Backward compatibility:** strictly additive.
- **Out of scope:**
  - Refactoring `spawnAgent`/`runFlow` to make them more testable (use the existing `SpawnOptions` seam: `modelRegistry` + `resolvedModelId`).
  - Replacing existing seam tests (model-resolution, code-node, etc.) — they stay.
  - Network/integration tests against real providers.
