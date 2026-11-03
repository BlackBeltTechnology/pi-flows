import { configDefaults, defineConfig } from "vitest/config";

// Exclude sibling git worktrees (`.worktrees/<branch>/`) so `npm test` only
// runs this checkout's suites.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    // Faux e2e suites spawn sessions and code handlers; a loaded 2-core CI
    // runner can take ~10s where a laptop takes <0.5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
