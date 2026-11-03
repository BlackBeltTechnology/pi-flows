# Proposal: classifier-decisions

## Why

Every flow decision point (autonomous `fork`, a fork's "Other" free text, `agent-decision`, a loop's "done or fix again?") is a classification: pick one label from the `branches:` map. Today pi-flows answers it by spawning a full agent session. That costs seconds and thousands of tokens per decision, returns no confidence, and when the agent returns no valid branch the engine silently takes the first one (`flow-execution.ts`, both `spawnForkDecisionAgent` and `executeAgentDecisionStep`).

Classifier models now exist that answer exactly this question type and return probabilities and a confidence:

- **pi-ai 1.x (built into pi):** `ctx.modelRegistry.classify(model, { state, questions })`, with TypeSafe Jev, Cloudflare Clef, OpenAI GPT-6 Luna and llama.cpp.
- **`@blackbelt-technology/pi-system-one` 0.11 (npm, no runtime dependencies):** `predict()` over a configurable backend chain (TypeSafe-format HTTP, managed local backends, an `llm` fallback), with an off-machine gate, per-caller calibration (`shadow`/`enforce`) and a hashed decision log.

pi-flows has to work **with or without pi-agent-dashboard**. The System One library is standalone; the dashboard only adds the settings screen, managed local backends and calibration. When the dashboard is installed, every pi-flows decision point should appear there automatically. Without it, a direct pi-ai classifier ref or a hand-written `system-one.json` must be enough.

## What Changes

- **New `decider:` chain** on decision points: an ordered list whose entries are `system-one`, a pi-ai classifier model ref (`provider/model`, e.g. `typesafe/jev-latest`), or `agent`. The first entry that returns a *trusted*, *valid* label decides. Set per step, per flow (`decider:` at top level), or system-wide (`flows.decider` setting, project overrides global). **Default `[agent]`: existing flows behave exactly as today.**
- **Trust policy** (`trust: auto | calibrated | confidence`, `min_confidence`, default `auto` / `0.75`): `calibrated` accepts a System One answer only in `enforce` mode; `confidence` accepts any answer at or above `min_confidence`; `auto` uses `calibrated` when a calibration record exists for that backend and decision point, otherwise `confidence`. An untrusted answer is a **shadow** answer: it is recorded and the chain continues.
- **Branch descriptions.** A branch MAY be written `label: { to: <step>, means: "<criterion>" }`; the existing `label: <step>` form stays valid. `means` becomes the classifier criterion. Fork options are their own criterion.
- **Decision state.** An optional `state:` map on decision steps (template-expanded) is what the classifier sees; default `{ task }` (plus `question` and `userText` for fork "Other").
- **No silent default.** A classifier answer whose label is not a branch is a failed attempt. When every entry of the chain fails, the step fails with an error that lists each attempt. The silent first-branch fallback is removed for decision steps.
- **Dashboard integration without dashboard code.** System One decision points register as consumer `pi-flows:<flow>:<step>`, so they show up in the dashboard's System One settings for retargeting, calibration and the decision log. pi-flows supplies its own in-process `llm` caller (one structured completion, not an agent session) so System One `llm` backends work inside pi.
- **Privacy follows one switch.** When `~/.pi/agent/system-one.json` sets `allowOffMachine: false`, pi-flows also skips direct pi-ai classifier refs that are not local.
- **Observability.** A new `flow:decision` event carries every attempt (decider, label, confidence, mode, trusted, latency, reason) and which one routed; shadow answers record whether they agreed with the deciding entry. The TUI decision line shows the decider used and its confidence.
- **New dependency:** `@blackbelt-technology/pi-system-one ^0.11.0` (no transitive dependencies).

## Capabilities

### New Capabilities
- `classifier-decisions`: the decider chain on flow decision points, classifier question mapping, trust/shadow policy, System One and pi-ai backends, privacy gate, failure behaviour and the `flow:decision` event.

### Modified Capabilities
- `decision-routing`: the routing requirement now names classifiers as a label source, and branches gain the `{ to, means }` form.

## Impact

- **Code:** `extensions/flow-engine/flow-execution.ts` (decision paths go through one `decide()` helper), new `extensions/flow-engine/decider/` (chain, System One adapter, pi-ai adapter, llm caller, trust), `flow-parser-yaml.ts` (`decider`, `state`, branch object form), `flow-validate*.ts`, `flow-tui.ts` / `flow-persist.ts` (event), settings helper from `resolver-agnostic-model-refs`.
- **Depends on:** `resolver-agnostic-model-refs` (settings helper, `model:resolve` fallback used by the `llm` caller, decision-agent selection for the `agent` entry).
- **Subsumes** the "invalid or missing branch silently takes the first branch" item of the planned `fix-decision-routing` change, for decision steps.
- **Docs:** `docs/flows.md`, `docs/flow-authoring.md`, `docs/events-api.md`, `CHANGELOG.md`.
- **Out of scope:** `ctx.classify()` in `code-decision` handlers, `flow_run` routing by classifier, writing calibration fixtures to disk.

## Discipline Skills

`security-hardening` (state sent off-machine, privacy gate), `observability-instrumentation` (`flow:decision` event), `doubt-driven-review` (removing the silent first-branch fallback, new dependency).
