// Coverage / confidence signal. A deterministic, honest heuristic over what
// the run actually produced — how many sources were kept, and how well the
// answer's own [N] citations hold up under the lexical verifier. It is NOT a
// claim that the answer is correct; it's a fast "how much should I trust this
// at a glance, and what should I double-check" read. Pure and unit-testable.

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ConfidenceInput {
  sources: number; // kept sources behind the answer
  citationsTotal: number; // inline [N] citations the verifier checked
  citationsSupported: number; // of those, how many cleared the recall threshold
}

export interface ConfidenceAssessment {
  level: ConfidenceLevel;
  sources: number;
  citationsTotal: number;
  citationsSupported: number;
  // supported / total, or 1 when there were no citations to check.
  supportRatio: number;
  reasons: string[];
}

export function assessConfidence(input: ConfidenceInput): ConfidenceAssessment {
  const { sources, citationsTotal, citationsSupported } = input;
  const supportRatio = citationsTotal > 0 ? citationsSupported / citationsTotal : 1;

  const reasons: string[] = [];
  reasons.push(`${sources} source${sources === 1 ? "" : "s"}`);
  reasons.push(
    citationsTotal > 0
      ? `${citationsSupported}/${citationsTotal} citations supported`
      : "no inline citations",
  );

  // Low when the evidence base is thin, the answer cited nothing the verifier
  // could check, or a meaningful share of citations failed.
  const thin = sources <= 2;
  const uncited = citationsTotal === 0;
  const weakCites = citationsTotal > 0 && supportRatio < 0.6;

  let level: ConfidenceLevel;
  if (thin || uncited || weakCites) {
    level = "low";
    if (thin) reasons.push("thin evidence base");
    if (uncited) reasons.push("answer not grounded in citations");
    else if (weakCites) reasons.push("several citations weakly supported");
  } else if (sources >= 5 && citationsTotal >= 3 && supportRatio >= 0.9) {
    level = "high";
  } else {
    level = "medium";
  }

  return { level, sources, citationsTotal, citationsSupported, supportRatio, reasons };
}

// Exported for unit tests. One-line stderr summary, mirroring the cost line.
export function formatConfidenceLine(a: ConfidenceAssessment): string {
  return `confidence · ${a.level} · ${a.reasons.join(" · ")}`;
}
