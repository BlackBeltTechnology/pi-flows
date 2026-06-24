# Harden Flow Automation Wiring

## Why

The input/output wiring between nodes is functional but untested and silently fault-tolerant in ways that hide real authoring mistakes. Verified in source:

1. **`reads` is parsed but never wired.** `AgentStep.reads` is declared (`types.ts:92`) and parsed (`flow-parser-yaml.ts`) but never consumed in execution — a dead field that silently does nothing.
2. **No input-dependency validation.** A step can reference `${{result.a.summary}}` *without* `blockedBy: [a]`. The scheduler may run them concurrently; if `a` hasn't finished, the template expands to `""` (`execution.ts:40-52`) with no error and no warning.
3. **Silent fallback everywhere.** Missing step, missing input, missing typed-output field all expand to empty string. Zero diagnostics — a typo in `${{result.X.outptu}}` produces empty data, not an error.
4. **No test coverage of wiring.** `__tests__/` covers abort, persistence, orphan reconciliation, model resolution — but template expansion, input wiring, typed outputs, and flow-ref propagation have **0% coverage**.

For automation to be trustworthy (the InvoiceBot use case depends on this), wiring needs end-to-end tests and fail-loud diagnostics for the common mistakes.

## What changes

Test the wiring end-to-end and fix the issues the tests expose.

- **End-to-end wiring tests (primary deliverable).** New `__tests__/` suites for: `expandTemplateVariables` (all 10 variable forms), typed-output extraction and `${{result.X.name}}` resolution, input-block resolution, flow-ref result merge (`flow-execution.ts` sub-flow propagation), and edge cases (missing step, missing field, empty value, loop counters).
- **Validate input references against `blockedBy`.** At flow-load/validation time, flag any `${{result.X...}}` reference where `X` is not a (transitive) `blockedBy` dependency — surfaced as a `Diagnostic` (`types.ts` already has the `Diagnostic` shape).
- **Fail-loud on unresolved references (or warn).** Distinguish "intentionally empty" from "typo / missing field". At minimum, emit a validation `Diagnostic` for references to unknown step IDs or unknown declared outputs.
- **Resolve the `reads` field.** Either wire it (inject named file contents into context) or remove it and its parsing. Pick one; do not leave a parsed-but-dead field. Decision recorded in the change's design notes.
- **Clarify loop counter semantics.** Document and test whether `${{loop.X.iteration}}` is 0- or 1-based; align docs (`flows.md`) with behavior.

## Impact

- **Affected specs:** `flow-wiring` capability — template-variable resolution, input/dependency validation diagnostics, flow-ref propagation, loop counter semantics.
- **Affected code:** new `__tests__/` suites; `execution.ts` (expansion diagnostics), flow validation path (reference-vs-`blockedBy` check), `types.ts`/`flow-parser-yaml.ts` (`reads` resolution or removal).
- **Backward compatibility:** tests are additive. New diagnostics may turn previously-silent typos into validation errors/warnings — intended, but could surface latent issues in existing flow files. Resolving `reads` is breaking only if a flow relied on it being silently ignored (it does nothing today, so impact is near-zero).
- **Out of scope:**
  - The generic code node and agent-contract changes (separate proposals) — though their outputs flow through this same wiring and will benefit from the tests.
  - Rewriting the template engine; this change hardens and tests the existing one.
