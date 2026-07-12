// Fuzz the LLM-output boundary — what the model returns is not trusted to be
// well-formed, and in a report it can quote arbitrary web content verbatim.
// Two contracts pinned here:
//   1. The HTML export path never throws and never leaks a raw
//      HTML-significant character out of escapeHtml — that's the XSS seam in
//      `deepdive --html`.
//   2. parsePlan/parseCritique either return a well-formed Plan/Critique or
//      throw a plain Error (the agent loop's retry contract) — never a hang,
//      never a malformed object that flows into the search fan-out.
import { markdownToHtml, escapeHtml, extractHeadings } from "../dist/markdown.js";
import { parsePlan, parseCritique } from "../dist/plan.js";

export function fuzz(data) {
  const s = data.toString("utf8");

  if (typeof markdownToHtml(s) !== "string") {
    throw new Error("markdownToHtml returned a non-string");
  }
  if (!Array.isArray(extractHeadings(s))) {
    throw new Error("extractHeadings returned a non-array");
  }

  const esc = escapeHtml(s);
  if (/[<>"']/.test(esc) || /&(?!amp;|lt;|gt;|quot;|#39;)/.test(esc)) {
    throw new Error("escapeHtml let a raw HTML-significant character through");
  }

  for (const [name, parse] of [
    ["parsePlan", parsePlan],
    ["parseCritique", parseCritique],
  ]) {
    let out;
    try {
      out = parse(s);
    } catch (e) {
      if (!(e instanceof Error)) {
        throw new Error(`${name} threw a non-Error: ${typeof e}`);
      }
      continue; // rejecting hostile input loudly is the contract
    }
    if (
      !out ||
      !Array.isArray(out.queries) ||
      out.queries.some((q) => typeof q !== "string" || q.trim().length === 0) ||
      typeof out.reasoning !== "string"
    ) {
      throw new Error(`${name} returned a malformed result`);
    }
    if (name === "parsePlan" && (out.queries.length < 1 || out.queries.length > 8)) {
      throw new Error(`parsePlan query count out of bounds: ${out.queries.length}`);
    }
    if (name === "parseCritique" && (typeof out.done !== "boolean" || out.queries.length > 3)) {
      throw new Error("parseCritique returned a malformed Critique");
    }
  }
}
