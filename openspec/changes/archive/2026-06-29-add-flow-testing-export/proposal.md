# Provide a public flow-testing API (`pi-flows/testing`)

## Why

pi-flows actively encourages **downstream flow packages** (`docs/creating-packages.md`, "author a downstream pi-flow package"). But there is no provided way for a downstream author to test the flow they just authored. The only working test infrastructure is `__tests__/faux-harness.ts`, which:

- is **not published** — `package.json#files` ships `extensions/`, `agents/`, `skills/` but **not** `__tests__/`;
- is **not exported** — `exports` exposes only `"."` → `extensions/index.ts`, which re-exports just `CodeNodeContext`, `CodeNodeHandler`, `FlowHardError`, and the `activate` default;
- reaches into engine internals via deep relative paths (`../extensions/flow-engine/execution.js`, `flow-execution.js`) and a hand-written walk to pi-coding-agent's **nested** `pi-ai/compat.js`.

The net effect: the harness only resolves *inside the pi-flows repo*. An installed dependency cannot import it. A downstream author who wants to assert that their flow's routing, wiring, fan-in, and loops behave correctly has no provided tool — their realistic options are (B) test handlers as plain functions (no engine, no routing coverage) or (C) rebuild the nested-pi-ai trick by hand against unexported `.js` paths (fragile).

This is a missing rung on a ladder pi-flows already advertises: we tell people to author downstream packages, but give them no way to test them against the real engine.

## What changes

Graduate the faux-model harness from internal test scaffolding to a **first-class, published API** under a dedicated subpath export:

```jsonc
// package.json
"exports": {
  ".":         "./extensions/index.ts",
  "./testing": "./extensions/flow-engine/testing.ts"   // NEW
},
"files": ["extensions/", "agents/", "skills/", ...]      // already ships extensions/
```

Concretely:

1. **Relocate** the faux-provider machinery from `__tests__/faux-harness.ts` into a shipped module `extensions/flow-engine/testing.ts`. The existing `__tests__/faux-harness.ts` becomes a thin re-export so the in-repo suites are unchanged.
2. **Export** a minimal, stable surface from `pi-flows/testing`: the faux flow runner (`runFauxFlow`), the single-agent runner (`spawnFaux`), the scripting verbs (`scriptFinish`, `scriptToolThenFinish`, `scriptError`, `scriptSlowText`), the helpers (`makeAgent`, `lastUserText`), a flow loader (`parseFlowYamlString`), and the supporting types.
3. **Harden** the nested-`pi-ai` resolution so it works when pi-flows is an *installed* dependency (npm-hoisted, npm-nested, and pnpm symlink layouts) — not only in the dev-clone layout. This is the load-bearing risk (see `design.md`).

A downstream author can then write, in their own repo:

```ts
import { runFauxFlow, scriptFinish, parseFlowYamlString } from "@blackbelt-technology/pi-flows/testing";
```

— no deep imports, no nested-pi-ai trick, no living inside pi-flows.

## Impact

- **Affected specs:** `package-manifest` (new `./testing` subpath export), `faux-model-testing` (harness graduates to a published, consumable surface + cross-package-manager resolution requirement).
- **Affected code:** `package.json` (`exports`), new `extensions/flow-engine/testing.ts`, `__tests__/faux-harness.ts` (becomes a re-export), the nested-`pi-ai` resolver.
- **Affected consumers:** downstream flow packages gain an in-repo, real-engine flow test path. Existing in-repo `faux-*.test.ts` suites continue to pass unchanged.
- **Backward compatibility:** strictly additive to the public surface. The `"."` export is untouched.
- **Out of scope:**
  - Changing pi-coding-agent to re-export `registerFauxProvider` through a stable subpath (would remove the nested-pi-ai walk entirely, but it's a different package).
  - A scaffolding command / template for downstream test files.
  - Exporting `runFlow` / `spawnAgent` as public API (kept internal behind the faux runners — see `design.md` for the semver rationale, which narrows the original full-`runFlow` sketch).
