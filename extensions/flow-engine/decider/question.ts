// ---------------------------------------------------------------------------
// Decision → one classifier `choice` question. See change: classifier-decisions (D3).
// ---------------------------------------------------------------------------

import type { DecisionQuestion } from "./types.js";

export interface QuestionInput {
  branches: Record<string, string>;
  branchMeans?: Record<string, string>;
  /** Fork options: each is its own criterion. */
  options?: string[];
  /** Fork question (added to the state for "Other"). */
  question?: string;
  /** Expanded task; a fork without `task` passes its question here. */
  task: string;
  /** Expanded `state:` map; replaces the default `{ task }`. */
  declaredState?: Record<string, string>;
  /** Fork "Other" free text. */
  userText?: string;
}

/**
 * The decision agent's view of the same inputs a classifier gets: every branch
 * with its `means`, and the expanded `state:` map when declared. Appended to the
 * agent's task so an agent-routed decision is not made blind.
 */
export function decisionAgentContext(
  labels: string[],
  branchMeans: Record<string, string> | undefined,
  declaredState: Record<string, string> | undefined,
): string {
  const lines = ["Branches (call finish with exactly one of these as `branch`):"];
  for (const l of labels) lines.push(branchMeans?.[l] ? `- ${l}: ${branchMeans[l]}` : `- ${l}`);
  if (declaredState && Object.keys(declaredState).length > 0) {
    lines.push("", "State:");
    for (const [k, v] of Object.entries(declaredState)) lines.push(`- ${k}: ${v}`);
  }
  return lines.join("\n");
}

export function buildQuestion(input: QuestionInput): DecisionQuestion {
  const criteria: Record<string, string> = {};
  if (input.options) {
    for (const o of input.options) criteria[o] = o;
  } else {
    for (const label of Object.keys(input.branches)) criteria[label] = input.branchMeans?.[label] ?? label;
  }
  const state: Record<string, string> = input.declaredState ? { ...input.declaredState } : { task: input.task };
  if (input.userText !== undefined) {
    if (input.question !== undefined) state.question = input.question;
    state.userText = input.userText;
  }
  return { state, question: { type: "choice", instructions: input.task, criteria } };
}
