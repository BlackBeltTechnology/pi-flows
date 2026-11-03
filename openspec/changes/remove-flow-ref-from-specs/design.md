# Design: remove-flow-ref-from-specs

## Context

`flow-ref` was removed from the code earlier (no parser case, no executor, `NodeKind` without it), but three main specs were not updated.

## Goals / Non-Goals

**Goals:** specs match the code. **Non-Goals:** reintroducing sub-flows.

## Decisions

**D1:** The scenario name "Fork, decision, and flow-ref nodes emit their kind" is kept (the validator requires MODIFIED requirements to keep scenario names); only its body changes.

## Risks / Trade-offs

None: specs only.
