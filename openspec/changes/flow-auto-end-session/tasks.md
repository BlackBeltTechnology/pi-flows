## 1. Resolve the surfacing mechanism (design Q1) — do first

- [x] 1.1 Determine how pi-flows causes a host-visible `agent_end` for an event-launched flow run: (a) run `flow:run` inside a real agent turn, (b) a pi-coding-agent API to emit `agent_end`, or (c) dashboard maps forwarded `flow:complete` → its `agent_end` finalize path. Record the decision in design.md.
- [x] 1.2 If (c), scope moves to pi-agent-dashboard; this change then only guarantees `flow:complete` carries the outcome metadata. Note the split.

## 2. Failing tests first

- [x] 2.1 Test: on flow completion the completion signal carries `{ status, summary }` sourced from the flow result (success + failure/aborted cases).
- [x] 2.2 Test: emitting the completion signal does NOT call `ctx.shutdown()` / does not tear down the session.
- [x] 2.3 Keep the `FlowResult.status` tests (success → "success", cancel → "aborted").
- [x] 2.4 Run new tests; confirm red.

## 3. Remove the shutdown/opt-in machinery

- [x] 3.1 Remove `auto_end` from `FlowConfig` (`types.ts`) and the parser (`flow-parser-yaml.ts`).
- [x] 3.2 Remove the mode/interactivity gate and the `ctx.shutdown()` wiring (`auto-end.ts` gate, `index.ts` session_start capture of mode/shutdown).
- [x] 3.3 Keep `FlowResult.status` population.

## 4. Emit the completion signal + consolidate persistence

- [x] 4.1 On `flow:complete`, emit the `agent_end`-equivalent signal with `{ status, summary }` (per the mechanism chosen in §1). Unconditional; no gate.
- [x] 4.2 **Remove `emitCompletionMarker`** and its call in `flow-tui.ts` onFlowComplete; the completion message (assistant text = outcome summary, well-formed zero `usage`) opens the `hasAssistant` flush gate instead. Keep `emitStartMarker`.
- [x] 4.3 Test: exactly one message is appended at flow end and it opens the flush gate (buffered events persist for /resume); no separate `finished` marker.
- [x] 4.4 Confirm 2.1, 2.2, 4.3 pass.

## 5. Docs + skill (delegate docs/ to a subagent)

- [x] 5.1 Remove `auto_end` and all shutdown wording from `docs/flows.md`, `docs/flow-authoring.md`, `docs/public-api.md`.
- [x] 5.2 Document the completion signal (outcome metadata, no shutdown) where relevant.
- [x] 5.3 `skills/manage-flows/SKILL.md` (+ `.pi` sync): remove `auto_end`; note flow completion emits outcome metadata.
- [x] 5.4 `CHANGELOG.md`: supersede the auto-end entry with the completion-signal design.

## 6. Verify

- [x] 6.1 `npm run lint && npm run typecheck && npm test` green.
- [x] 6.2 `openspec validate flow-auto-end-session`.
- [x] 6.3 Live check: a dashboard automation `flows.run` finalizes (displays success/failure) instead of timing out.
