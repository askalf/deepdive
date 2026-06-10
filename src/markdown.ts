// Minimal, hand-rolled Markdown → HTML renderer.
//
// deepdive's "one runtime dependency" rule (see CLAUDE.md) rules out a
// markdown library, but the HTML export (`deepdive export <id> --format=html`)
// needs to turn the synthesizer's GitHub-flavored markdown into a polished,
// shareable document. This covers exactly the subset the synthesizer emits:
// ATX headings, paragraphs, bold/italic, inline + fenced code, links,
// ordered/unordered lists, GFM tables, blockquotes, horizontal rules, and the
// inline `[N]` citation markers (turned into superscript anchors so a reader
// can jump to the source).
//
// Pure over strings; no DOM, no deps. If the synthesizer starts emitting a
// construct this doesn't handle, the text falls through as an escaped
// paragraph rather than breaking — fail soft, since this is presentation, not
// data.

export interface MarkdownToHtmlOptions {
  // When set, an inline `[N]` citation renders as
  // `<sup><a href="#<prefix><N>">N</a></sup>` so it links to the rendered
  // source list. When omitted, `[N]` renders as a plain `<sup>[N]</sup>`.
  citationAnchorPrefix?: string;
  // When true, headings get a slug `id` (deduped with -2/-3 suffixes) so a
  // table of contents — or any deep link — can target them. The slugs match
  // what extractHeadings() produces for the same document.
  headingIds?: boolean;
}

// Private-use sentinels that cannot occur in escaped source text. Used to
// "park" already-generated HTML so later inline passes never touch it.
const PARK_OPEN = String.fromCharCode(0xe000);
const PARK_CLOSE = String.fromCharCode(0xe001);

// Render a markdown document to an HTML fragment (no <html>/<body> wrapper —
// the caller owns the document shell). Block-level first, inline second.
export function markdownToHtml(md: string, opts: MarkdownToHtmlOptions = {}): string {
  const lines = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: string[] = [];
  const slugger = opts.headingIds ? createSlugger() : undefined;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip; blocks are separated structurally.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block: ``` or ~~~ (optional language hint, which we ignore).
    const fence = /^(```+|~~~+)(.*)$/.exec(line.trim());
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== marker) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or run off the end)
      blocks.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Horizontal rule.
    if (/^(\s*[-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push("<hr>");
      i++;
      continue;
    }

    // ATX heading (# … ######).
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const idAttr = slugger ? ` id="${slugger(headingPlainText(text))}"` : "";
      blocks.push(`<h${level}${idAttr}>${renderInline(text, opts)}</h${level}>`);
      i++;
      continue;
    }

    // GFM table: a header row of `| … |` immediately followed by a
    // separator row of dashes/colons.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push(renderTable(tableLines, opts));
      continue;
    }

    // Blockquote: one or more consecutive `> ` lines.
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(`<blockquote>${markdownToHtml(quoted.join("\n"), opts)}</blockquote>`);
      continue;
    }

    // Lists: a run of ordered (`1.`) or unordered (`-`/`*`/`+`) items.
    if (isListItem(line)) {
      const ordered = isOrderedItem(line);
      const items: string[] = [];
      while (i < lines.length && isListItem(lines[i]) && isOrderedItem(lines[i]) === ordered) {
        // Gather continuation lines (non-blank, non-item) into the same <li>
        // so wrapped list text stays together.
        let item = lines[i].replace(LIST_ITEM_RE, "");
        i++;
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          !isListItem(lines[i]) &&
          !/^#{1,6}\s/.test(lines[i])
        ) {
          item += " " + lines[i].trim();
          i++;
        }
        items.push(`<li>${renderInline(item.trim(), opts)}</li>`);
      }
      const tag = ordered ? "ol" : "ul";
      blocks.push(`<${tag}>\n${items.join("\n")}\n</${tag}>`);
      continue;
    }

    // Paragraph: consume until a blank line or a line that starts a new block.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !startsNewBlock(lines[i], lines[i + 1])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${renderInline(para.join(" ").trim(), opts)}</p>`);
  }

  return blocks.join("\n");
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

function isListItem(line: string): boolean {
  return LIST_ITEM_RE.test(line);
}

function isOrderedItem(line: string): boolean {
  return /^\s*\d+[.)]\s+/.test(line);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|")) return false;
  return /^\|?(\s*:?-{1,}:?\s*\|)+\s*$/.test(t);
}

function startsNewBlock(line: string, next: string | undefined): boolean {
  if (/^#{1,6}\s/.test(line)) return true;
  if (/^(```+|~~~+)/.test(line.trim())) return true;
  if (/^(\s*[-*_])(\s*\1){2,}\s*$/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (isListItem(line)) return true;
  if (isTableRow(line) && next !== undefined && isTableSeparator(next)) return true;
  return false;
}

function renderTable(tableLines: string[], opts: MarkdownToHtmlOptions): string {
  const splitRow = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const header = splitRow(tableLines[0]);
  const bodyRows = tableLines.slice(2).map(splitRow);

  const thead =
    "<thead><tr>" +
    header.map((c) => `<th>${renderInline(c, opts)}</th>`).join("") +
    "</tr></thead>";
  const tbody =
    "<tbody>" +
    bodyRows
      .map(
        (cells) =>
          "<tr>" +
          cells.map((c) => `<td>${renderInline(c, opts)}</td>`).join("") +
          "</tr>",
      )
      .join("") +
    "</tbody>";
  return `<table>${thead}${tbody}</table>`;
}

// Inline rendering. Escape HTML once up front, then layer markup back on via
// sentinel-parked placeholders so we never re-process generated tags. Order
// matters: code spans and links are extracted first (their contents must not
// be touched by later passes), then citations, then emphasis.
export function renderInline(text: string, opts: MarkdownToHtmlOptions = {}): string {
  let out = escapeHtml(text);

  const stash: string[] = [];
  const park = (html: string): string => {
    stash.push(html);
    return `${PARK_OPEN}${stash.length - 1}${PARK_CLOSE}`;
  };

  // Inline code: `code` — content is literal, no further processing.
  out = out.replace(/`([^`]+)`/g, (_m, code) => park(`<code>${code}</code>`));

  // Links: [text](url). The text is already escaped; the url is escaped too.
  // Only http(s), mailto, file, and in-doc (#) targets are allowed — anything
  // else (javascript:, data:) renders as plain text to avoid injection in the
  // exported HTML.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (!isSafeHref(url)) return m;
    return park(`<a href="${url}" rel="noopener noreferrer">${label}</a>`);
  });

  // Citations: a `[N]` (or `[N][M]…`) run NOT immediately followed by `(`
  // (which would make it a link we failed to parse). Each [N] becomes a
  // superscript anchor (when a prefix is set) or a plain bracketed superscript.
  out = out.replace(/(?:\[\d+\])+(?!\()/g, (run) => {
    const ids = run.match(/\d+/g) ?? [];
    const sups = ids
      .map((id) =>
        opts.citationAnchorPrefix
          ? `<a href="#${opts.citationAnchorPrefix}${id}">${id}</a>`
          : `[${id}]`,
      )
      .join("");
    return park(`<sup class="cite">${sups}</sup>`);
  });

  // Bold then italic. **x** / __x__ first so the single-char rules don't eat
  // the markers.
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, x) => `<strong>${x}</strong>`);
  out = out.replace(/__([^_]+)__/g, (_m, x) => `<strong>${x}</strong>`);
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, (_m, pre, x) => `${pre}<em>${x}</em>`);
  out = out.replace(/(^|[^_])_([^_\s][^_]*?)_(?!_)/g, (_m, pre, x) => `${pre}<em>${x}</em>`);

  // Restore parked spans.
  const restoreRe = new RegExp(`${PARK_OPEN}(\\d+)${PARK_CLOSE}`, "g");
  out = out.replace(restoreRe, (_m, n) => stash[Number(n)]);
  return out;
}

function isSafeHref(url: string): boolean {
  if (url.startsWith("#")) return true;
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) return true;
  return /^(https?:|mailto:|file:)/i.test(url);
}

// Exported for unit tests. Escapes the five HTML-significant characters.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Heading slugs / table of contents ───────────────────────────────────────

export interface Heading {
  level: number; // 1-6
  text: string; // plain text (inline markup stripped)
  slug: string; // matches the id markdownToHtml({headingIds:true}) emits
}

// Exported for unit tests. Strips the inline markup a heading can carry so the
// slug (and TOC label) comes from the readable text: code ticks, emphasis
// markers, links → their label, citation [N] runs dropped.
export function headingPlainText(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/(?:\[\d+\])+(?!\()/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\s][^_]*?)_(?!_)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

// Exported for unit tests. Lowercase, non-alphanumeric runs → "-", trimmed.
// Empty input falls back to "section" so an id is never blank.
export function slugify(s: string): string {
  // Collapse every non-alphanumeric run to a single "-", so leading/trailing
  // separators are at most one char each — trimmed with linear string ops
  // rather than an anchored `-+` regex (which trips js/polynomial-redos).
  let slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (slug.startsWith("-")) slug = slug.slice(1);
  if (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug || "section";
}

// Stateful slug allocator: repeated headings get -2, -3, … suffixes. Both
// markdownToHtml and extractHeadings walk headings in document order with a
// fresh slugger, so the same document always yields the same ids.
function createSlugger(): (text: string) => string {
  const used = new Map<string, number>();
  return (text: string) => {
    const base = slugify(text);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

// Exported for the HTML export's table of contents. Walks the document's ATX
// headings in order (skipping fenced code blocks, mirroring markdownToHtml's
// block parsing) and returns level/text/slug for each.
export function extractHeadings(md: string): Heading[] {
  const lines = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: Heading[] = [];
  const slugger = createSlugger();
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    const fence = /^(```+|~~~+)/.exec(trimmed);
    if (fence) {
      const marker = fence[1];
      i++;
      while (i < lines.length && lines[i].trim() !== marker) i++;
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (heading) {
      const text = headingPlainText(heading[2].trim());
      out.push({ level: heading[1].length, text, slug: slugger(text) });
    }
    i++;
  }
  return out;
}
