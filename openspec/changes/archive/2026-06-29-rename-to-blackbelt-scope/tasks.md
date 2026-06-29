# Tasks

> All tasks below were performed in commit `0c3bb8e`. This file is the retrospective task list.

- [x] 1. Rename `"name"` in `package.json` to `@blackbelt-technology/pi-flows`.
- [x] 2. Bump `"version"` to `0.2.1`.
- [x] 3. Add `"publishConfig": { "access": "public" }` so the scoped name publishes as public on first push.
- [x] 4. Add `"repository"` pointing at `git+https://github.com/BlackBeltTechnology/pi-flows.git`.
- [x] 5. Add a `"files"` allowlist (`extensions/`, `agents/`, `README.md`, `CHANGELOG.md`, `LICENSE`) so `npm publish` ships only consumer-facing artefacts.
- [x] 6. Add a new `npm-publish` spec capturing the manifest contract.
- [ ] 7. (Operational, not part of the commit) Run `npm publish` against the npm registry once 2FA / access tokens are sorted.
- [ ] 8. (Follow-up) Update any in-tree docs or examples that still reference the bare name `pi-flows` as an import specifier to use the new scoped name.
