// ---------------------------------------------------------------------------
// Manage-flows skill materialization.
//
// pi-flows owns a PROJECT-LOCAL copy of the manage-flows skill at
// `<projectRoot>/.pi/skills/manage-flows/SKILL.md`, materialized from the packaged
// template. This is the writable, per-project, natively-discovered location —
// the packaged copy under node_modules is read-only and reinstall-volatile and
// is NEVER written here. The copy's `disable-model-invocation` frontmatter is
// kept in sync with edit-mode: enabled ⇒ false (model sees it), disabled ⇒ true
// (hidden from the prompt, still reachable via the explicit /skill: command).
// See openspec/changes/add-edit-mode-toggle.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CONFIG_DIR = ".pi";
const SKILL_NAME = "manage-flows";

/** Project-local SKILL.md path that pi-flows owns. */
export function editFlowSkillPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR, "skills", SKILL_NAME, "SKILL.md");
}

/** Packaged template SKILL.md path (read-only source). */
export function editFlowTemplatePath(pkgRoot: string): string {
  return join(pkgRoot, "skills", SKILL_NAME, "SKILL.md");
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const DMI_LINE_RE = /^disable-model-invocation:.*$/m;

/**
 * Set/replace the `disable-model-invocation` key in a SKILL.md's YAML
 * frontmatter, preserving the rest of the frontmatter and the body. If the
 * document has no frontmatter block, one is prepended.
 */
export function setDisableModelInvocation(source: string, disabled: boolean): string {
  const line = `disable-model-invocation: ${disabled}`;
  const fm = FRONTMATTER_RE.exec(source);
  if (!fm) {
    return `---\n${line}\n---\n\n${source}`;
  }
  const body = DMI_LINE_RE.test(fm[1])
    ? fm[1].replace(DMI_LINE_RE, line)
    : `${fm[1]}\n${line}`;
  return source.replace(FRONTMATTER_RE, `---\n${body}\n---`);
}

/**
 * Ensure the project-local edit-flow skill exists (materialized from the
 * packaged template when absent) and that its `disable-model-invocation`
 * reflects `enabled` (disabled = !enabled). Never writes under `node_modules`.
 * Idempotent. Returns whether the file was newly created and its path.
 */
export function syncEditFlowSkill(
  projectRoot: string,
  pkgRoot: string,
  enabled: boolean,
): { created: boolean; path: string } {
  const dest = editFlowSkillPath(projectRoot);
  const created = !existsSync(dest);

  let source: string;
  if (created) {
    const template = editFlowTemplatePath(pkgRoot);
    source = existsSync(template)
      ? readFileSync(template, "utf-8")
      : `---\nname: ${SKILL_NAME}\ndescription: Create and edit pi-flows flows and agents from the main session.\n---\n\n# Manage Flows\n`;
  } else {
    source = readFileSync(dest, "utf-8");
  }

  const updated = setDisableModelInvocation(source, !enabled);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, updated, "utf-8");
  return { created, path: dest };
}
