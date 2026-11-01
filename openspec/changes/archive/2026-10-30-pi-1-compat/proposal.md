## Why

pi-flows 0.5.0 declares its pi peers as `>=0.84.1 <1.0.0`, so it fails to install cleanly on pi 1.x hosts. The pi 1.0.0–1.0.2 changelogs contain no breaking extension API changes, so the cap is the only real blocker. pi-flows also imports `@sinclair/typebox`, which only resolves through a legacy root-only alias pi keeps for old extensions; pi itself has shipped `typebox` 1.x since 0.69.0 (1.3.7 on 0.84.1, 1.3.27 on 0.86.1 and 1.0.2).

## What Changes

- Peer range for `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` widens from `>=0.84.1 <1.0.0` to `>=0.84.1 <2.0.0`. Every currently supported host stays supported.
- Peer `@sinclair/typebox ^0.34.49` replaced by `typebox ^1.3.7` (satisfied by every supported host).
- devDependencies: the three pi packages bumped from `^0.86.1` to `^1.0.2`; `@sinclair/typebox` replaced by `typebox ^1.3.27`.
- Import rewrites: 5 source files (`import { Type }`) and 2 test files (`import { Value } from ".../value"`) switch from `@sinclair/typebox` to `typebox`.
- Fix whatever the pi 1.0.2 / typebox 1.x typecheck and test runs surface. Changelog review flags one candidate: the hand-built `ResourceLoader` in `extensions/flow-engine/execution.ts` may need members added since 0.99.0 (built-in extensions).
- Release: version 0.5.0 → 0.6.0 with a CHANGELOG entry, published via the existing `Release` workflow once lint, typecheck and tests are green.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `package-manifest`: the supported peer range requirement now admits pi 1.x and declares the `typebox` peer.

## Impact

- `package.json` (peers, devDependencies, version), `package-lock.json`.
- `extensions/flow-engine/tools/flow-write.ts`, `extensions/flow-engine/tools/flow-agents.ts`, `extensions/flow-engine/tools/ask-user.ts`, `extensions/flow-engine/guard.ts`, `extensions/flow-context/index.ts`; possibly `extensions/flow-engine/execution.ts`.
- `__tests__/finish-retry.test.ts`, `__tests__/output-validation.test.ts`.
- `CHANGELOG.md`.
- Downstream: no consumer loses support. Kept separate from `fix-flow-agent-model-resolution`.

## Discipline Skills

`doubt-driven-review` (public peer-range change before publish).
