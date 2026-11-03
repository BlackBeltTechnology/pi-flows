import type { CodeNodeContext } from "../../../../extensions/flow-engine/types.js";

interface Input {
  a: unknown; b: unknown; c: unknown;
  confidence_a: unknown; confidence_b: unknown; confidence_c: unknown;
}

/** Majority vote over three reviewer verdicts ("approve" | "reject" | anything else = abstain). */
export default async function tally(input: Input, ctx: CodeNodeContext) {
  const votes = [input.a, input.b, input.c].map(String);
  const counts = { approve: 0, reject: 0, abstain: 0 };
  for (const v of votes) {
    if (v === "approve") counts.approve++;
    else if (v === "reject") counts.reject++;
    else counts.abstain++;
  }
  const majority = counts.approve > counts.reject ? "approve" : counts.reject > counts.approve ? "reject" : "tie";
  const confidences = [input.confidence_a, input.confidence_b, input.confidence_c];
  // whole-value references deliver the declared `type: number` outputs as numbers
  const numeric = confidences.every((c) => typeof c === "number");
  const mean = numeric ? (confidences as number[]).reduce((s, c) => s + c, 0) / 3 : -1;
  ctx.setSummary(`votes ${counts.approve}/${counts.reject}/${counts.abstain} -> ${majority}`);
  return { majority, counts, mean_confidence: mean };
}
