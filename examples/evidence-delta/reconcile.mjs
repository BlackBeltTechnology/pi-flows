// reconcile.mjs — thin wrapper: snapshot a named Goal-X, stage role+flow into the
// per-invocation disposable workspace, verify manifest digests host-side.
// Usage: node reconcile.mjs <owned-disposable-target> --goal <id|file> --question "..." [--project <root>] [--spec <name>] [--log <file>] [--verify-only] [--no-role]
// Never auto-runs a model, never writes outside target, never touches guard.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node reconcile.mjs <owned-disposable-target> --goal <id|file> --question \"...\" [--project <root>] [--spec <name>] [--log <file>] [--verify-only] [--no-role]");
  process.exit(1);
}
const snap = spawnSync(process.execPath, [join(here, "snapshot.mjs"), ...args], { encoding: "utf8" });
// INVARIANT: snapshot-first ordering is load-bearing — ensureOwnedDir inside snapshot.mjs
// canonicalizes the target before any staging below; never stage without this call.
process.stdout.write(snap.stdout);
process.stderr.write(snap.stderr);
if (snap.status !== 0) process.exit(snap.status ?? 1);
// Verify manifest digests host-side (independent of producer claim).
const target = resolve(args[0]);
const dir = join(target, ".pi/flows/fixtures");
for (const name of ["contract.md", "surface.md", "goal-excerpt.md", "MANIFEST.md"]) {
  const p = join(dir, name);
  if (!existsSync(p)) { console.error(`reconcile: missing fixture ${name}`); process.exit(1); }
}
const manifest = readFileSync(join(dir, "MANIFEST.md"), "utf8");
for (const name of ["contract.md", "surface.md", "goal-excerpt.md"]) {
  const bytes = readFileSync(join(dir, name));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!manifest.includes(`${name}: fixture SHA256 ${digest}`)) {
    console.error(`reconcile: digest mismatch for ${name}`);
    process.exit(1);
  }
}
console.log("reconcile: frozen bundle verified. Host runs the unchanged role-lab:evidence-delta Flow against this bundle (read-only, advisory only).");
// Stage role+flow into the SAME disposable workspace so the bundle is a complete
// runnable unit (no stale synthetic reads from another cwd). Refuses to overwrite
// modified files; verifies symlink-safe parents. Skipped with --no-role.
if (!args.includes("--no-role") && !args.includes("--verify-only")) {
  const pairs = [
    ["agent.md", ".pi/flows/agents/role-evidence-delta.md"],
    ["flow.yaml", ".pi/flows/flows/role-lab/evidence-delta/flow.yaml"],
  ];
  const plan = [];
  for (const [from, to] of pairs) {
    const dest = join(target, to);
    let cur = dest;
    while (cur !== target) {
      try { if (lstatSync(cur).isSymbolicLink()) { console.error(`reconcile: symlink in bundle path: ${cur}`); process.exit(1); } }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      cur = dirname(cur);
    }
    const data = readFileSync(join(here, from));
    let exists = false;
    try {
      const curData = readFileSync(dest);
      if (!curData.equals(data)) { console.error(`reconcile: refusing to overwrite modified file: ${dest}`); process.exit(1); }
      exists = true;
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    plan.push({ dest, data, exists });
  }
  for (const { dest, data, exists } of plan) {
    if (exists) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data, { flag: "wx" });
  }
  console.log("reconcile: role+flow staged into disposable workspace (no live activation).");
}
