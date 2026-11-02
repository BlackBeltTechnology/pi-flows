/** `npm test` must not collect tests from sibling git worktrees under `.worktrees/`. */
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import config from "../vitest.config.js";

describe("vitest config", () => {
  const exclude = (config as any).test?.exclude as string[];
  it("excludes .worktrees/** and keeps vitest's default excludes", () => {
    expect(exclude).toContain(".worktrees/**");
    for (const d of configDefaults.exclude) expect(exclude).toContain(d);
  });
});
