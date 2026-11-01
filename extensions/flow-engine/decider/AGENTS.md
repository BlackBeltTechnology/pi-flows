# DOX — extensions/flow-engine/decider

Decider chain for flow decision points. See change: classifier-decisions.

| `chain.ts` | `parseDeciderSpec`, `resolveDecider` (step → flow → `flows.decider` → `[agent]`), `decide()` (trust, shadow, timeout, abort), `describeAttempts`. |
| `llm-caller.ts` | `createLlmCaller`: in-process System One `llm` caller; one completion, role via `resolveAgentModel` (session fallback), `isLocal` rule. |
| `pi-ai.ts` | `createPiAiEntry`: `provider/model` classifier through `modelRegistry.classify`; credential check, off-machine gate. |
| `question.ts` | `buildQuestion`: branch `means`/options → one `choice` question; default/declared/"Other" state. |
| `runtime.ts` | `makeEntryRunner`: maps entry names to adapters; privacy gate read once per run from `system-one.json`; `entryOverrides` test seam. |
| `system-one.ts` | `createSystemOneEntry`: lazy `predict()` from `@blackbelt-technology/pi-system-one`, consumer `pi-flows:<flow>:<step>`, calibration lookup. |
| `trust.ts` | `isTrusted`: `calibrated` / `confidence` / `auto`. |
| `types.ts` | Shared types: answers, attempts, `EntryResult`, `DecisionOutcome`, `DecisionQuestion`. |
