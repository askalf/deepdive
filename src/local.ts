// Local file source ingestion — `--include=<path>` injects files and
// directories as pre-fetched sources alongside whatever the search /
// browser pipeline finds on the web.
//
// Supports:
//   .pdf        — extracted via src/pdf.ts (requires pdfjs-dist)
//   .md, .txt   — read as plain text
//   .html, .htm — stripped of tags, then treated as text
//
// A local source's URL is the canonical `file://` URI for its absolute
// path; the synthesizer treats them like any other source and the
// citation footer renders a clickable file:// link.

import { promises as fs } from "node:fs";
import { resolve, basename, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractPdfText,
  PdfExtractorMissingError,
  type PdfExtractOptions,
} from "./pdf.js";
import type { SourceWithContent } from "./synthesize.js";

export interface LocalIngestOptions {
  // PDF page cap shared with the agent's web-PDF extraction.
  pdfMaxPages?: number;
  // Per-source word cap, mirrors maxWordsPerSource for web sources.
  maxWordsPerSource: number;
}

export interface LocalIngestResult {
  sources: Omit<SourceWithContent, "id">[];
  // Files that exist but couldn't be extracted (e.g. PDF without
  // pdfjs-dist installed, or unsupported extension). Reported, not fatal.
  skipped: { path: string; reason: string }[];
}

const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".text"]);
const HTML_EXTS = new Set([".html", ".htm"]);
const PDF_EXTS = new Set([".pdf"]);

// Public entry point. Walks every input path (file or directory), collects
// supported files, and extracts content. Errors on a single file are
// recorded in `skipped`; the rest of the batch still ingests.
export async function ingestLocalPaths(
  inputs: string[],
  opts: LocalIngestOptions,
): Promise<LocalIngestResult> {
  const sources: Omit<SourceWithContent, "id">[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const files = await expandPaths(inputs);

  for (const abs of files) {
    const ext = extname(abs).toLowerCase();
    try {
      const content = await readAndExtract(abs, ext, opts);
      if (content === null) {
        skipped.push({ path: abs, reason: `unsupported extension: ${ext}` });
        continue;
      }
      sources.push({
        url: pathToFileURL(abs).href,
        title: basename(abs),
        fetchedAt: Date.now(),
        content: clampWords(content, opts.maxWordsPerSource),
      });
    } catch (err) {
      const reason =
        err instanceof PdfExtractorMissingError
          ? "pdfjs-dist not installed"
          : (err as Error).message ?? "extraction failed";
      skipped.push({ path: abs, reason });
    }
  }

  return { sources, skipped };
}

async function readAndExtract(
  abs: string,
  ext: string,
  opts: LocalIngestOptions,
): Promise<string | null> {
  if (TEXT_EXTS.has(ext)) {
    return await fs.readFile(abs, "utf-8");
  }
  if (HTML_EXTS.has(ext)) {
    const html = await fs.readFile(abs, "utf-8");
    return stripTags(html);
  }
  if (PDF_EXTS.has(ext)) {
    const buf = await fs.readFile(abs);
    const pdfOpts: PdfExtractOptions = { maxPages: opts.pdfMaxPages };
    const result = await extractPdfText(new Uint8Array(buf), pdfOpts);
    return result.text;
  }
  return null;
}

// Walks a list of files / dirs / globs into an ordered list of absolute
// file paths. Directories are walked one level deep by default — recursing
// into arbitrary trees is opt-in to avoid surprising users with a
// thousand-file ingestion when they pointed at their home directory.
// Exported for unit tests.
export async function expandPaths(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of inputs) {
    const abs = resolve(raw);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue; // Missing path — skip silently; caller handles via no-results.
    }
    if (stat.isFile()) {
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
      continue;
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = extname(e.name).toLowerCase();
        if (
          !TEXT_EXTS.has(ext) &&
          !HTML_EXTS.has(ext) &&
          !PDF_EXTS.has(ext)
        ) {
          continue;
        }
        const full = abs + sep + e.name;
        if (!seen.has(full)) {
          seen.add(full);
          out.push(full);
        }
      }
    }
  }
  return out;
}

// Exported for unit tests. Minimal HTML→text — drops <script>/<style>
// and tags, decodes a small set of entities. The browser's text
// extraction is far better; this is for offline files only.
export function stripTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Word-cap, mirrors what extract.ts does for web sources.
function clampWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ") + " …";
}
