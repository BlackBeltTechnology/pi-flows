// snapshot.mjs — deterministic least-privilege frozen-bundle producer (v1.0.0).
// Usage: node snapshot.mjs <owned-disposable-target> --goal <id|file> --question "<=500ch>"
//   [--project <repo-root>] [--spec <approved-change>] [--log <project-local-file>] [--verify-only]
// Reads ONLY allowlisted within-project paths, enforces 8KB/file + 32KB total caps,
// rejects traversal/symlink/secret paths, writes per-invocation bundle + digest manifest.
// Never writes outside <target>, never touches global slots, never runs a model.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync as rdSync, statSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import console from "node:console";

const VERSION = "1.1.0";
const PER_FILE_CAP = 8192;
const TOTAL_CAP = 32768;
const DENY_RE = /(^|\/)(ideas|\.env[^/]*|.*secret.*|.*token.*|.*private.*)($|\/)/i;

function stampStale() {
  try {
    const rawTarget = process.argv[2];
    if (!rawTarget || String(rawTarget).startsWith("--")) return;
    const dir = join(resolve(String(rawTarget)), ".pi/flows/fixtures");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    writeFileSync(join(dir, ".STALE_" + new Date().toISOString().replace(/[:.]/g, "-")), "stale: failed snapshot invocation\n");
  } catch { /* best-effort only */ }
}
function fail(msg) { console.error("snapshot: " + msg); try { stampStale(); } catch { /* ignore */ } process.exit(1); }
function parseArgs(argv) {
  const out = { positional: [], goal: null, question: null, project: process.cwd(), spec: null, log: null, verifyOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--goal") out.goal = argv[++i];
    else if (a === "--question") out.question = argv[++i];
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--spec") out.spec = argv[++i];
    else if (a === "--log") out.log = argv[++i];
    else if (a === "--verify-only") out.verifyOnly = true;
    else if (a.startsWith("--")) fail("unknown flag " + a);
    else out.positional.push(a);
  }
  return out;
}
function ensureOwnedDir(target) {
  const t = resolve(target);
  let cur = t;
  // target itself must exist and be a real dir without symlink parents
  if (!existsSync(t)) fail("target must be an existing owned disposable directory: " + t);
  while (true) {
    let st;
    try { st = lstatSync(cur); } catch { fail("cannot stat " + cur); }
    if (st.isSymbolicLink()) fail("symlink rejected: " + cur);
    if (cur === dirname(cur)) break;
    if (cur === resolve("/")) break;
    const parent = dirname(cur);
    if (cur === parent) break;
    // only check up to filesystem root but stop once inside existing real path chain of target's ancestors that exist
    cur = parent;
    try { if (cur.length < 2) break; } catch { break; }
    if (existsSync(cur) && cur !== t) {
      // verify no symlink on the ancestor chain of t
      const rel = relative(cur, t);
      if (!rel.startsWith("..")) {
        // walk from cur down to t
        const parts = rel.split(sep).filter(Boolean);
        let walk = cur;
        for (const p of parts) {
          walk = join(walk, p);
          try { if (lstatSync(walk).isSymbolicLink()) fail("symlink parent rejected: " + walk); }
          catch { break; }
        }
        break;
      }
    }
    if (cur === dirname(cur)) break;
  }
  if (!statSync(t).isDirectory()) fail("target is not a directory: " + t);
  if (realpathSync(t) !== t) fail("target must be canonical (no symlinks): " + t);
  return t;
}
function insideRoot(root, p) {
  const r = resolve(root);
  const q = resolve(root, p);
  return q === r || q.startsWith(r + sep) ? q : null;
}
function safeRead(root, rel, cap = PER_FILE_CAP) {
  if (rel.includes("\0")) fail("NUL path rejected");
  if (rel.split("/").includes("..")) fail("traversal rejected: " + rel);
  const abs = insideRoot(root, rel);
  if (!abs) fail("escape rejected: " + rel);
  if (DENY_RE.test(rel)) fail("denied path class: " + rel);
  let st;
  try { st = lstatSync(abs); } catch { fail("missing allowed source: " + rel); }
  if (st.isSymbolicLink()) fail("symlink source rejected: " + rel);
  // reject symlink parents
  let walk = abs;
  const r = resolve(root);
  while (walk !== r && walk !== dirname(walk)) {
    try { if (lstatSync(walk).isSymbolicLink()) fail("symlink parent rejected: " + rel); } catch { break; }
    walk = dirname(walk);
    if (walk.length < r.length) break;
  }
  if (!st.isFile()) fail("not a file: " + rel);
  const raw = readFileSync(abs);
  let text = raw.toString("utf8");
  let truncated = false;
  if (raw.length > cap) { text = raw.subarray(0, cap).toString("utf8") + "\n\n[TRUNCATED at " + cap + " bytes]\n"; truncated = true; }
  return { text, bytes: raw.length, truncated, abs, rel };
}
function gitInfo(project) {
  const info = { sha: "UNKNOWN", status: "UNKNOWN", stat: "UNKNOWN", dirty: true };
  try { info.sha = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* keep UNKNOWN */ }
  try {
    const s = execFileSync("git", ["-C", project, "status", "--porcelain"], { encoding: "utf8" });
    info.status = s.slice(0, 4096);
    info.dirty = s.trim().length > 0;
  } catch { /* keep UNKNOWN */ }
  try {
    info.stat = execFileSync("git", ["-C", project, "diff", "--stat", "HEAD"], { encoding: "utf8" }).slice(0, 4096);
  } catch { /* keep UNKNOWN */ }
  return info;
}

const args = parseArgs(process.argv.slice(2));
if (args.positional.length !== 1) { console.error("Usage: node snapshot.mjs <owned-disposable-target> --goal <id|file> --question \"...\" [--project <root>] [--spec <change>] [--log <file>]"); process.exit(1); }
if (!args.question || args.question.length === 0 || args.question.length > 500) fail("--question is required (1..500 chars)");
const project = resolve(args.project);
if (!existsSync(project) || !statSync(project).isDirectory()) fail("project root missing: " + project);
const target = ensureOwnedDir(args.positional[0]);

// Resolve goal synchronously (ESM-safe, no require).
let goalRel;
{
  const direct = (() => { try { const q = resolve(project, args.goal); const r = resolve(project); return (q === r || q.startsWith(r + sep)) ? q : null; } catch { return null; } })();
  if (direct && existsSync(direct)) {
    const rel = relative(project, direct).split(sep).join("/");
    if (!rel.startsWith(".pi/goals/")) fail("goal must live under .pi/goals/: " + args.goal);
    goalRel = rel;
  } else {
    let names = [];
    try { names = rdSync(resolve(project, ".pi/goals")); } catch { fail("cannot list .pi/goals/; pass an explicit goal file"); }
    if (names.includes(args.goal)) {
      goalRel = ".pi/goals/" + args.goal;
    } else {
      const hits = names.filter((n) => n.includes(args.goal));
      if (hits.length === 0) fail("no goal matching id: " + args.goal);
      if (hits.length > 1) fail("ambiguous --goal \"" + args.goal + "\" matches " + hits.length + " files: " + hits.slice(0, 5).join(", ") + "; pass an exact filename");
      goalRel = ".pi/goals/" + hits[0];
    }
  }
}
if (args.verifyOnly) {
  const dir = join(target, ".pi/flows/fixtures");
  for (const name of ["contract.md", "surface.md", "goal-excerpt.md", "MANIFEST.md"]) {
    if (!existsSync(join(dir, name))) fail("verify-only: missing fixture " + name);
  }
  const manifest = readFileSync(join(dir, "MANIFEST.md"), "utf8");
  for (const name of ["contract.md", "surface.md", "goal-excerpt.md"]) {
    const digest = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
    if (!manifest.includes(`${name}: fixture SHA256 ${digest}`)) fail("verify-only: digest mismatch for " + name);
  }
  console.log(`snapshot ${VERSION} verify-only OK at ${dir}`);
  process.exit(0);
}
const chunks = [];
const warnings = [];
const goal = safeRead(project, goalRel);
chunks.push({ key: "goal", ...goal });
let specFiles = [];
if (args.spec) {
  if (args.spec.includes("..") || args.spec.includes("/") || args.spec.includes("\\")) fail("bad spec name: " + args.spec);
  for (const rel of [`openspec/changes/${args.spec}/proposal.md`, `openspec/changes/${args.spec}/design.md`, `openspec/changes/${args.spec}/tasks.md`]) {
    try { chunks.push({ key: "spec:" + basename(rel), ...safeRead(project, rel) }); specFiles.push(rel); }
    catch { warnings.push("MISSING_SPEC_FILE:" + rel); }
  }
}
let logChunk = null;
if (args.log) {
  logChunk = safeRead(project, args.log);
  chunks.push({ key: "log", ...logChunk });
}
const git = gitInfo(project);
if (git.dirty) warnings.push("DIRTY_GIT: working tree has uncommitted changes; snapshot frozen at " + git.sha);
for (const c of chunks) if (c.truncated) warnings.push("TRUNCATED:" + c.rel);

function excerpt(text, cap) { return text.length > cap ? text.slice(0, cap) + "\n\n[TRUNCATED at " + cap + " chars]\n" : text; }
const stamp = new Date().toISOString();
const contractMd =
  `# Frozen contract (per-invocation)\n\n## Provenance\n` +
  `- producer: evidence-delta-snapshot ${VERSION}\n- project: ${basename(project)}\n- goal: ${goalRel} (${goal.bytes} bytes)\n` +
  `- spec: ${specFiles.length ? specFiles.join(", ") : "none"}\n- git SHA: ${git.sha}\n- collected: ${stamp}\n\n` +
  `## Approved scope\nBounded offline reconciliation only. No mutation, approval, or live-state claim.\n\n## Warnings\n${warnings.length ? warnings.map((w) => "- " + w).join("\n") : "- none"}\n`;
const surfaceMd =
  `# Frozen surface (per-invocation)\n\n## Git status (truncated 4KB)\n\`\`\`\n${excerpt(git.status, 4096)}\n\`\`\`\n\n## Git diff --stat (truncated 4KB)\n\`\`\`\n${excerpt(git.stat, 4096)}\n\`\`\`\n` +
  (logChunk ? `\n## Log excerpt: ${logChunk.rel} (${logChunk.bytes} bytes)\n\`\`\`\n${excerpt(logChunk.text, 4096)}\n\`\`\`\n` : `\n## Log excerpt\nNo caller log supplied.\n`);
const goalExcerptMd =
  `# Frozen goal excerpt (per-invocation)\n\n## Goal source\n${goalRel} (${goal.bytes} bytes, frozen; live state UNKNOWN)\n\n## Excerpt (truncated 8KB)\n${excerpt(goal.text, 8192)}\n\n## Frozen operator question\n${args.question}\n\nLive owner/revision/status remain UNKNOWN without authorized fresh readback.\n`;

let fixtures = [
  ["contract.md", contractMd],
  ["surface.md", surfaceMd],
  ["goal-excerpt.md", goalExcerptMd],
];
let total = fixtures.reduce((n, [, t]) => n + Buffer.byteLength(t), 0);
if (total > TOTAL_CAP) fail(`bundle exceeds total cap ${TOTAL_CAP} (got ${total}); narrow --log/--spec`);
// provisional manifest digest lines (without question file; question is embedded in goal-excerpt)
const digests = new Map();
for (const [name, text] of fixtures) digests.set(name, createHash("sha256").update(text).digest("hex"));
const manifestMd =
  `# Frozen manifest (per-invocation)\n` +
  fixtures.map(([n]) => `- ${n}: fixture SHA256 ${digests.get(n)}`).join("\n") + `\n` +
  `- producer: evidence-delta-snapshot ${VERSION}\n- git SHA: ${git.sha}\n- collected: ${stamp}\n` +
  `- warnings: ${warnings.length ? warnings.join("; ") : "none"}\n`;
const manifestBytes = Buffer.byteLength(manifestMd);
if (total + manifestBytes > TOTAL_CAP) fail(`bundle exceeds total cap ${TOTAL_CAP} (fixtures ${total} + manifest ${manifestBytes}); narrow --log/--spec`);
fixtures.push(["MANIFEST.md", manifestMd]);

const outDir = join(target, ".pi/flows/fixtures");
mkdirSync(outDir, { recursive: true });
// preflight: refuse symlink escapes inside bundle path
{
  let walk = outDir;
  const t = resolve(target);
  while (walk.startsWith(t)) {
    try { if (lstatSync(walk).isSymbolicLink()) fail("symlink in bundle path: " + walk); } catch { break; }
    if (walk === t) break;
    walk = dirname(walk);
  }
}
for (const [name, text] of fixtures) writeFileSync(join(outDir, name), text);
const manifestJson = {
  producer: `evidence-delta-snapshot ${VERSION}`,
  collected: stamp,
  project: basename(project),
  goal: goalRel,
  specFiles,
  log: logChunk ? logChunk.rel : null,
  gitSHA: git.sha,
  warnings,
  files: fixtures.map(([n, t]) => ({ name: n, sha256: createHash("sha256").update(t).digest("hex"), bytes: Buffer.byteLength(t) })),
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifestJson, null, 2) + "\n");
console.log(`snapshot ${VERSION} wrote ${fixtures.length} fixtures to ${outDir} (total ${total} bytes, git ${git.sha.slice(0, 12)})`);
