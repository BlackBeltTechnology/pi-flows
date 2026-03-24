// ---------------------------------------------------------------------------
// Session File Tracker Extension
//
// Tracks file modifications (edit/write tool calls) per session.
// Provides session-scoped file counts + insertions/deletions for the footer.
// Also tracks subagent file modifications via flow:subagent-tool-result events.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
  // Track main session tool results
  pi.on("tool_result", (event: any) => {
    const toolName = event.toolName || "";
    const params = event.params || event.input || {};
    const result = event.result;

    if (toolName === "edit" && params.file_path && result?.diff) {
      recordEdit(params.file_path, result.diff);
    } else if (toolName === "write" && params.file_path && params.content) {
      const lineCount = (params.content as string).split("\n").length;
      recordWrite(params.file_path, lineCount);
    }
  });

  // Track subagent file modifications via bridge events
  pi.events?.on("flow:subagent-tool-result", (data: any) => {
    const { toolName, output } = data || {};
    if (toolName === "write" && output?.file_path) {
      const lineCount = output.lineCount || 0;
      recordWrite(output.file_path, lineCount);
    } else if (toolName === "edit" && output?.file_path && output?.diff) {
      recordEdit(output.file_path, output.diff);
    }
  });

  // Reset on new session
  pi.on("session_start", () => {
    files.clear();
  });
}
