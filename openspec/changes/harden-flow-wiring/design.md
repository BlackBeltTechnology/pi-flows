## Context

The input/output wiring between flow nodes (template expansion in `execution.ts:40-99`, result context in `flow-execution.ts`, typed-output extraction) is functional but **untested** and **silently fault-tolerant**: any unresolved reference expands to `""` with no diagnostic. A typo (`${{result.X.totl}}`) or a missing dependency produces empty data, not an error. This change hardens the wiring with fail-loud validation and end-to-end tests, and removes one dead field.

Scope is deliberately narrow: harden and test the **existing** template/wiring engine. No new template syntax, no trigger/reactive work.

## Goals / Non-Goals

**Goals**
- End-to-end test coverage of template expansion, typed-output extraction, input resolution, and flow-ref propagation.
- Fail-loud, load-time validation for malformed references.
- Remove the dead `reads` field.
- Make loop-counter semantics consistent (1-based) and tested.

**Non-Goals**
- New template variables or expression syntax.
- Rewriting the template engine.
- Triggers / reactive flow lifecycle (separate future epic).
- Changing agent/code node contracts (already shipped).

## Decisions

### D1 — Remove the `reads` field
`AgentStep.reads` (`types.ts:139`) is parsed (`flow-parser-yaml.ts:123-127`) but never consumed, undocumented, and used by zero flows. Its likely intended purpose — inject file contents into a step's context — is now served by the shipped `context_files` agent frontmatter field. **Remove the type field and its parser block.** No deprecation shim (nothing depends on it).

### D2 — Hard error at load on bad references
A template reference to an unknown step ID, or to an unknown output field of a known step, SHALL fail flow validation (block the run). Standard fields (`summary`, `status`, `artifacts`, `files`, `fullOutput`) always resolve. A typed-output field is "known" if the referenced step is an agent/code node that declares it in `outputs`. References to steps with no statically-knowable outputs (e.g. fields beyond the standard set on a step that declares none) are treated as unknown-field errors.

### D3 — Reference requires ordering (blockedBy + routing reachability)
A reference to `${{result.X...}}` is valid only if X is guaranteed to have completed before the referencing step — i.e. X is a transitive `blockedBy` ancestor **or** X reaches the referencing step through an `on_complete`/`on_error` routing chain. Otherwise it is a hard validation error. **Reject auto-adding the edge:** it hides author intent and risks cycles/surprise serialization in a scheduler whose parallelism depends on explicit `blockedBy`. The reachability computation MUST include routing edges to avoid false positives on legitimately-ordered routing targets.

### D4 — Loop counter is 1-based and consistent
`${{loop.X.iteration}}` is 1-based (matches `docs/flows.md:453`). Today the counter is incremented at the loop-decision step (`flow-execution.ts:1001`), so the loop **body** on its first pass can observe `0` (fallback) while the decision step observes `1` — an off-by-one. **Fix so the body executing pass N and the decision step agree on N**, and lock it with a test.

### D5 — Fold in adjacent hardening
Two small items ride along since they are the same test/correctness theme:
- Add the missing **finish-retry test** (agent that fails declared-output schema is re-prompted up to `MAX_FINISH_RETRIES`, then soft-fails) — the one acknowledged coverage gap from the agent-node verification.
- Correct the cosmetic `code-node` spec wording: success sets `files` to `[]` (a `ResultFile[]`), not `""`.

## Risks / Trade-offs

- **Latent breakage surfaced:** existing in-the-wild flows with typos or undeclared-dependency references will now fail validation instead of silently running on empty data. This is the intended behavior change; mitigated by clear diagnostic messages naming the offending reference and step.
- **Reachability computation cost:** transitive blockedBy + routing reachability is O(steps·edges); negligible for realistic flows, computed once at load.
- **False-positive risk** if reachability omits routing edges — explicitly mitigated by D3.

## Migration Plan

Additive tests + load-time validation. Removing `reads` is safe (unused). Authors of flows that referenced undeclared steps must add the missing `blockedBy` (or routing) edge, or fix the typo — the diagnostic tells them which.

## Open Questions

None — all four design decisions resolved with the stakeholder.
