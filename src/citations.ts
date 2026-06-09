// Citation formatting — turns a list of sources into a numbered footnote
// block, gives each source a stable [n] id, and provides utilities for
// rendering inline citations into markdown.

export interface Source {
  id: number;
  url: string;
  title: string;
  fetchedAt: number;
  // v0.14.0 — page publication date as epoch ms, when one could be extracted
  // from the page (JSON-LD / meta / <time>). Optional and additive: older
  // sessions and PDF/local sources load with it undefined.
  publishedAt?: number;
}

export function buildSourceTable(sources: Omit<Source, "id">[]): Source[] {
  return sources.map((s, i) => ({ id: i + 1, ...s }));
}

export function renderSourcesMarkdown(sources: Source[]): string {
  if (sources.length === 0) return "";
  const lines = sources.map((s) => {
    const date = new Date(s.fetchedAt).toISOString().slice(0, 10);
    const safeTitle = escapeMd(s.title) || s.url;
    const published =
      typeof s.publishedAt === "number"
        ? ` · published ${new Date(s.publishedAt).toISOString().slice(0, 10)}`
        : "";
    return `${s.id}. [${safeTitle}](${s.url}) — fetched ${date}${published}`;
  });
  return "## Sources\n\n" + lines.join("\n") + "\n";
}

export function renderAnswerMarkdown(question: string, answer: string, sources: Source[]): string {
  const header = `# ${escapeMd(question)}\n\n`;
  const body = answer.trim() + "\n\n";
  return header + body + renderSourcesMarkdown(sources);
}

function escapeMd(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")");
}
