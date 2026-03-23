// ---------------------------------------------------------------------------
// Flow Engine -- Result Parser
//
// Standardized <result> XML parser for all agents. Uses regex only -- no
// DOM/XML parser dependency. Handles self-closing tags, multiline content,
// and gracefully falls back when the envelope is missing.
// ---------------------------------------------------------------------------

import type { ParsedResult, ResultFile } from "./types.js";

// ---- Regex patterns -------------------------------------------------------

const RESULT_BLOCK_RE =
  /<result\s+status="(complete|error|blocked)"[^>]*>([\s\S]*?)<\/result>/;

const FILE_ENTRY_RE =
  /<file\s+path="([^"]+)"\s+action="([^"]+)"\s*\/?\s*>/g;

const ARTIFACTS_BLOCK_RE =
  /<artifacts>([\s\S]*?)<\/artifacts>/;

const SUMMARY_BLOCK_RE =
  /<summary>([\s\S]*?)<\/summary>/;

const FALLBACK_TRUNCATE = 2000;

// ---- Public API -----------------------------------------------------------

/**
 * Parse a `<result>` XML envelope from raw agent output.
 *
 * The output may contain arbitrary text before and after the `<result>` block.
 * If no `<result>` block is found the function returns a fallback with
 * `status="unknown"` and the raw output (truncated to 2 000 chars) as the
 * summary.
 */
export function parseResult(output: string): ParsedResult {
  const resultMatch = RESULT_BLOCK_RE.exec(output);

  if (!resultMatch) {
    return {
      status: "unknown",
      files: [],
      artifacts: "",
      summary: output.length > FALLBACK_TRUNCATE
        ? output.slice(0, FALLBACK_TRUNCATE)
        : output,
    };
  }

  const status = resultMatch[1] as ParsedResult["status"];
  const inner = resultMatch[2];

  // -- Files ----------------------------------------------------------------
  const files: ResultFile[] = [];
  let fileMatch: RegExpExecArray | null;

  // Reset lastIndex since we reuse the global regex
  FILE_ENTRY_RE.lastIndex = 0;
  while ((fileMatch = FILE_ENTRY_RE.exec(inner)) !== null) {
    files.push({
      path: fileMatch[1],
      action: fileMatch[2] as ResultFile["action"],
    });
  }

  // -- Artifacts ------------------------------------------------------------
  const artifactsMatch = ARTIFACTS_BLOCK_RE.exec(inner);
  const artifacts = artifactsMatch ? artifactsMatch[1].trim() : "";

  // -- Summary --------------------------------------------------------------
  const summaryMatch = SUMMARY_BLOCK_RE.exec(inner);
  const summary = summaryMatch ? summaryMatch[1].trim() : "";

  return { status, files, artifacts, summary };
}

/**
 * Check whether a specific element exists inside a raw `<artifacts>` XML
 * string.
 *
 * The `elementPath` uses dot-notation rooted at `artifacts`, e.g.
 * `"artifacts.gaps"` checks for the presence of a `<gaps` opening tag.
 */
export function hasArtifactElement(
  artifacts: string,
  elementPath: string,
): boolean {
  const el = elementPath.replace(/^artifacts\./, "");
  return new RegExp(`<${el}[\\s>]`).test(artifacts);
}
