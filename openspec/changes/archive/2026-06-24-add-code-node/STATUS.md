# OpenSpec Change Status — add-code-node

**Last updated:** 2026-06-24  
**Change name:** add-code-node  
**Status:** 🟢 **SPECIFICATION COMPLETE** — Ready for implementation

---

## Artifacts Summary

| Artifact | Status | Purpose |
|----------|--------|---------|
| **proposal.md** | ✅ Complete | High-level rationale, goals, and scope |
| **design.md** | ✅ Complete | Architecture, decisions (D1–D8), risks, and trade-offs |
| **specs/code-node/spec.md** | ✅ Complete | Detailed requirements and test scenarios (12 requirements, 40+ scenarios) |
| **tasks.md** | ✅ Complete | 8-section implementation task breakdown (~38 subtasks) |
| **DASHBOARD-DELEGATION-BRIEF.md** | ✅ **NEW** | Dashboard rendering and event contract specifications |
| **IMPLEMENTATION-GUIDE.md** | ✅ **NEW** | Sequenced implementation plan with dependencies, tests, and verification gates |

---

## Change Scope at a Glance

**Feature:** Add a `code` step type to pi-flows that runs deterministic TypeScript as a first-class DAG node with typed input/output wiring.

**Why:** Today, every pi-flows node that does work runs an LLM agent. Deterministic pipelines (e.g., InvoiceBot's goal flow: validation → extraction → reconciliation) have to fake deterministic steps with single-tool agents — expensive, non-deterministic, and wrong. A `code` node fills this gap.

**What changes:**
- New `CodeStep` type (id, target, inputs, outputs, blockedBy, on_complete, on_error, timeout)
- Parser: recognize `type: code` in YAML
- Executor: in-process dynamic import of handler modules, input wiring, output validation, error routing
- Generation: auto-scaffold `.ts.default` templates with full `Input`/`Output` interfaces and a stub default export
- Drift detection: textual comparison of YAML-declared outputs vs. real handler's interface block
- Conditional fix: `check: <stepId>.<typedOutput>` now resolves typed outputs, not just fullOutput
- Dashboard: new `kind: "code"` discriminator on events so code cards render distinctly

**Impact:**
- ✅ Strictly additive — no breaking changes
- ✅ Backward compatible — existing flows unaffected; code nodes are opt-in
- ✅ Clean error contract — soft/hard failures routed per `node-failure-model`
- ✅ Ergonomic — generated templates eliminate signature guessing
- ✅ Composable — typed outputs integrate seamlessly into downstream wiring

---

## Key Design Decisions

| Decision | Rationale | Consequence |
|----------|-----------|-------------|
| **In-process dynamic import (D1)** | Mirrors agent execution; no new runtime dependencies | v1 has no process isolation / hard-kill (acceptable, agents have same limit) |
| **`.ts.default` reference templates (D2)** | Separate tool-owned template from author's real file → no overwrite hazard | Template always regenerated, author copies to real file and implements |
| **Convention from node `id` (D3)** | Default path `.pi/flows/handlers/<flow>/<id>.ts`; `target:` overrides | Handler location is never ambiguous |
| **Strict output contract + primitive coercion (D4)** | All declared keys required, no extras; strings pass, primitives coerced, objects rejected | Clean boundary errors; author must deliberately serialize objects |
| **Conditional typed-output resolution (D5)** | `check: <stepId>.<key>` resolves typed outputs, falls back to fullOutput | Code nodes' output-only value is now fully accessible in branches |
| **Soft timeout only (D6)** | Cooperative abort via `ctx.signal`; no hard-kill | Honest about isolation ceiling; makes deadline opt-in |
| **Generation decoupled from validation (D7)** | Runs on `flow_write` success, not during validation; triggered by `/flows:generate` too | Idempotent, robust; persisted YAML is the source of truth |
| **Files not tracked (D8)** | `files = ""`; paths exposed as typed outputs instead | Simpler model; explicit wiring beats post-hoc introspection |

---

## Critical Paths and Dependencies

### Implementation Order (Critical Path)

```
1. Types & exports
   ↓
2. Parser & validation
   ↓
3. Code-node executor
   ↓
4. Dispatch & conditional fix
   ↓
7. Integration & verification
```

**Parallel paths (no blocking):**
- 5. Handler generation → 6. Generation triggers (prerequisite: parser ✓)
- 8. Documentation (prerequisite: implementation ✓)
- Dashboard-side work (parallel; non-blocking on pi-flows)

### Test Strategy

- **Per-task testing:** each section (1–6) has dedicated test scenarios before implementation.
- **Gate verification:** each section must pass tests + lint + typecheck before advancing.
- **Integration phase:** end-to-end flow with code node → downstream agent to verify result wiring.

---

## Known Unknowns

These were left as "Open Questions" in the design:

1. Should `.ts.default` templates be auto-added to `.pi/flows/handlers/.gitignore`? **Recommendation:** Yes, add them on first generation to `.gitignore`.
2. Exact wording of auto-generated summary fallback (key list vs. compact value preview)? **Recommendation:** `"<id>: <JSON of outputs>"` (e.g., `"validate-nav: {valid:'true',nav_record:'...'}"`) — concise and machine-parseable.
3. Whether `CodeNodeHandler<I, O>` is worth exporting in v1? **Recommendation:** Yes, it's useful for IDE autocomplete in handler modules; minimal cost.

---

## Backward Compatibility

✅ **Strictly backward compatible.** Code nodes are opt-in; existing flows are unaffected. The only global change is the widening of `conditional` field resolution to include typed outputs — a **safe enhancement** that brings existing agent-step typed outputs into scope alongside code nodes.

**Rollback strategy:** if needed, each task has a revert path (see IMPLEMENTATION-GUIDE.md, "Rollback / Reversal" section).

---

## Next Steps

### For the main team:
1. **Review artifacts** — confirm the specification, design, and delegation brief align with team intent.
2. **Greenlight implementation** — approve the IMPLEMENTATION-GUIDE.md sequencing.
3. **Assign tasks** — map sections 1–7 to implementers; assign dashboard work to pi-agent-dashboard team.

### For pi-flows implementers:
1. Start with **Task 1** (Types & exports) — ~30 min, zero dependencies.
2. Follow the IMPLEMENTATION-GUIDE.md sequence; each section has test-first recommendations.
3. Verify tests + lint + typecheck before moving to the next section.

### For pi-agent-dashboard team:
1. Review DASHBOARD-DELEGATION-BRIEF.md.
2. Implement code-node rendering (new `kind:"code"` branch in step-card renderer).
3. (Optional) Add `handlerPath` field reading for hyperlink-to-implementation.
4. Test rendering with pi-flows live events (once pi-flows changes are deployed).

---

## Specification Completeness Checklist

- ✅ Proposal covers all "why / what / scope / impact" questions
- ✅ Design document covers all decisions (D1–D8) with rationale + alternatives
- ✅ Spec has 12 detailed requirements with 40+ test scenarios
- ✅ Tasks document breaks work into 8 testable sections with ~38 subtasks
- ✅ Implementation guide sequences work, identifies dependencies, explains each section
- ✅ Dashboard brief specifies rendering contract and event shapes
- ✅ All open questions noted (gitignore, summary format, export decision)

**Conclusion:** Specification is **COMPLETE AND READY FOR IMPLEMENTATION**.
