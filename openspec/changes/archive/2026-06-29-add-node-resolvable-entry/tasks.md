# Tasks

- [x] 1. Add `"type": "module"`, `"main": "./extensions/index.ts"`, and `"exports": { ".": "./extensions/index.ts" }` to `package.json`. Keep `pi.extensions` unchanged.
- [ ] 2. Verify `require.resolve("pi-flows")` succeeds from any cwd that has pi-flows in `node_modules` (test with a temp consumer package and a symlink).
- [ ] 3. Verify `import("pi-flows")` from a pi-running process returns an object whose `default` is the activator function.
- [ ] 4. Add `package-manifest` spec capturing the contract (see `specs/package-manifest/spec.md`).
- [ ] 5. Run existing tests to confirm pi's own loader still picks up the package via `pi.extensions`.
- [ ] 6. Update `README.md` "Installation" section to mention pi-flows can now be imported as a regular Node module (with the caveat that the importer must run under a TS-aware loader).
- [ ] 7. Bump version to `0.1.2` and note in CHANGELOG.
