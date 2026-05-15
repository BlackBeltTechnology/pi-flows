// ---------------------------------------------------------------------------
// Session File Tracker Extension
//
// Tracks file modifications (edit/write tool calls) in the main session.
// Provides session-scoped file counts + insertions/deletions for the footer.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---- Types ----------------------------------------------------------------

interface FileStats {
  insertions: number;
  deletions: number;
}

export interface TrackerStats {
  fileCount: number;
  insertions: number;
  deletions: number;
}

// ---- Diff parser ----------------------------------------------------------

function parseDiffCounts(diff: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { insertions, deletions };
}

// ---- Tracker state --------------------------------------------------------

const files = new Map<string, FileStats>();
let onChangeCallback: (() => void) | null = null;

function recordEdit(filePath: string, diff: string): void {
  const counts = parseDiffCounts(diff);
  const existing = files.get(filePath);
  if (existing) {
    existing.insertions += counts.insertions;
    existing.deletions += counts.deletions;
  } else {
    files.set(filePath, { insertions: counts.insertions, deletions: counts.deletions });
  }
  onChangeCallback?.();
}

function recordWrite(filePath: string, lineCount: number): void {
  if (!files.has(filePath)) {
    files.set(filePath, { insertions: lineCount, deletions: 0 });
  }
  onChangeCallback?.();
}

export function getFileStats(): TrackerStats {
  let insertions = 0;
  let deletions = 0;
  for (const stats of files.values()) {
    insertions += stats.insertions;
    deletions += stats.deletions;
  }
  return { fileCount: files.size, insertions, deletions };
}

export function onFileStatsChange(cb: () => void): void {
  onChangeCallback = cb;
}

// ---- Extension activation -------------------------------------------------

export function activate(pi: ExtensionAPI) {
  // Track main session tool results only (not subagent calls)
  pi.on("tool_result", (event: any) => {
    const toolName = event.toolName || "";
    const input = event.input || {};
    const details = event.details;

    // Edit tool: input.path + details.diff
    if (toolName === "edit" && input.path && details?.diff) {
      recordEdit(input.path, details.diff);
    }
    // Write tool: input.path + input.content
    else if (toolName === "write" && input.path && input.content) {
      const lineCount = (input.content as string).split("\n").length;
      recordWrite(input.path, lineCount);
    }
  });

  // Reset on new session
  pi.on("session_start", () => {
    files.clear();
  });
}
