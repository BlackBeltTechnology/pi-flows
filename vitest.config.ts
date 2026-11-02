import { configDefaults, defineConfig } from "vitest/config";

// Exclude sibling git worktrees (`.worktrees/<branch>/`) so `npm test` only
// runs this checkout's suites.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".worktrees/**"],
  },
});
