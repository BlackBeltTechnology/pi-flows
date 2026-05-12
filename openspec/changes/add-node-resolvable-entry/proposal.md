# Add Node-resolvable package entry

## Why

`pi-flows` declares only `pi.extensions` in `package.json`, with no `main`, `exports`, or `module` field. Pi-coding-agent loads the package fine — it reads `pi.extensions` directly and feeds the absolute entry path to `jiti.import`. But **any other package that tries to `import("pi-flows")` or `require.resolve("pi-flows")`** through Node's standard module resolution fails with `MODULE_NOT_FOUND`, because Node has no idea what file represents the package.

This blocks legitimate cross-package consumers. Concretely it blocked `pi-agent-dashboard`'s `flows-anthropic-bridge-plugin` from probing `pi-flows` as a peer (see `pi-agent-dashboard/openspec/changes/fix-flows-anthropic-bridge-resolution/`). The bridge's `createRequire(cwd).resolve("pi-flows")` failed even with the package symlinked into the dashboard's `node_modules`, because the symlinked package lacked an entry point.

This is a structural problem: pi packages historically expose themselves only through pi-specific metadata, which makes them invisible to the broader JS ecosystem.

## What changes

Update `pi-flows/package.json` to add the standard Node entry-point fields, pointing at the same file `pi.extensions` already points at:

```json
{
  "name": "pi-flows",
  "type": "module",
  "main": "./extensions/index.ts",
  "exports": { ".": "./extensions/index.ts" },
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

The `.ts` extension is intentional. Every pi runtime preloads `jiti-register.mjs`, which handles TypeScript on the fly. Any consumer that runs under pi (and that's the only context in which importing `pi-flows` makes sense) inherits the jiti loader, so `.ts` imports just work.

Add a new spec `package-manifest` that locks this contract in and documents the rationale, so it survives future package.json refactors.

## Impact

- **Affected specs:** new `package-manifest` capability.
- **Affected code:** `pi-flows/package.json` only.
- **Affected consumers:**
  - `flows-anthropic-bridge-plugin` peer probe now resolves `pi-flows` via `createRequire(...).resolve("pi-flows")` instead of relying on a behavioural-detection fallback.
  - Any third-party tool that introspects pi packages via Node's resolver now gets a real answer instead of `MODULE_NOT_FOUND`.
- **Backward compatibility:** strictly additive. Pi's own loader continues reading `pi.extensions` and is unaffected by the new `main`/`exports` fields.
- **Out of scope:**
  - Shipping a compiled `dist/` (would need a build step; the `.ts` entry path is fine because pi always has jiti).
  - Mandating this for all pi packages (this change only locks the contract for pi-flows).
