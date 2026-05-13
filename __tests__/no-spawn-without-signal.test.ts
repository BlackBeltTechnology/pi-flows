/**
 * Repo-lint: every `spawnAgent({...})` call site MUST pass an explicit
 * `signal:` field so AbortSignal threads through every spawn path.
 *
 * Regex-based — no AST. Catches the common mistake of adding a new spawn
 * site that forgets the signal field. Skips spawnAgent type/import
 * occurrences by matching only the actual call shape with an opening brace.
 *
 * See change: fix-pi-flows-end-to-end (Group 3, task 3.4).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_DIR = path.resolve(__dirname, "..", "extensions");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * For each file: find every `spawnAgent({` call and slice the substring
 * from that brace to the MATCHING closing brace (depth-aware). Then check
 * the slice contains the word `signal` (allowing whitespace/colon variants).
 */
function findOffenders(): Array<{ file: string; line: number; excerpt: string }> {
  const offenders: Array<{ file: string; line: number; excerpt: string }> = [];
  const files = walk(EXTENSIONS_DIR);
  for (const file of files) {
    const src = fs.readFileSync(file, "utf-8");
    const re = /spawnAgent\s*\(\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      const braceIdx = src.indexOf("{", match.index + "spawnAgent(".length);
      if (braceIdx < 0) continue;
      // Walk to matching closing brace
      let depth = 1;
      let i = braceIdx + 1;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
      }
      const slice = src.slice(braceIdx, i);
      if (!/\bsignal\s*:/.test(slice)) {
        const line = src.slice(0, match.index).split("\n").length;
        offenders.push({
          file: path.relative(EXTENSIONS_DIR, file),
          line,
          excerpt: slice.slice(0, 200),
        });
      }
    }
  }
  return offenders;
}

describe("repo-lint: spawnAgent calls require signal:", () => {
  it("every spawnAgent({...}) call passes a signal field", () => {
    const offenders = findOffenders();
    if (offenders.length > 0) {
      const lines = offenders.map(
        (o) => `  ${o.file}:${o.line}  →  ${o.excerpt.replace(/\s+/g, " ")}`,
      );
      throw new Error(
        `spawnAgent() called without a 'signal:' field:\n${lines.join("\n")}\n` +
          `\nEvery spawn site MUST thread the run's AbortSignal so abort propagates.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
