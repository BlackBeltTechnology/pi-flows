# Changelog

All notable changes to pi-flows will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — Unreleased

### Added

- **Additive emission of `flow:architect-error` alongside `flow:architect-init-error`.** All six init-error sites in `extensions/flow-workspace/index.ts` now emit a parallel `flow:architect-error` event with `{ phase: "init", reason, message }`. Surfaces architect init failures in the dashboard via the existing `FLOW_EVENT_MAP["flow:architect-error"]` mapping without renaming the TUI-internal event.
- **Additive emission of `flow:architect-cancelled` alongside `flow:architect-abort`.** The Ctrl+X abort in `extensions/flow-engine/flow-tui.ts` now also emits `flow:architect-cancelled` with `{ reason: "user-abort" }`. Surfaces user-initiated aborts in the dashboard via the existing `FLOW_EVENT_MAP["flow:architect-cancelled"]` mapping.
- **`flow:summary-started` event** emitted at the top of the `flow:complete` handler in `extensions/flow-summary/index.ts`. Dashboard observers can now render a "generating summary…" intermediate state. Matches the existing `flow:summary-ready` lifecycle event symmetrically.
- **`docs/dashboard-integration.md`** explaining the two-repo split: pi-flows owns the engine + events; pi-agent-dashboard's `packages/flows-plugin/` owns the React reaction. Documents why source relocation to pi-flows is not planned (the dashboard's primitive-registry pattern supersedes it). Linked from `README.md`.

### Changed

- **peerDependencies pinned away from `"*"`.** All four pi-namespace peers (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`) and matching `devDependencies` now declare real semver caret ranges (`^0.69.0` and `^0.34.49` respectively, matching the versions in CI). The package is now publishable on npm without peer-range warnings; no install-graph change for existing users (caret of currently installed version satisfies itself).

### Notes

- OpenSpec change: `align-with-dashboard-plugins`.
- Cross-repo follow-up in `pi-agent-dashboard` documented as a delegation brief inside the change folder: removes the stale "pi-flows intentionally NOT bundled until license declared" comment in `packages/shared/src/recommended-extensions.ts` and adds `"pi-flows"` to `BUNDLED_EXTENSION_IDS` (pi-flows has MIT `LICENSE` since `fe5f119`).
