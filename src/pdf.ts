// PDF text extraction — optional path, lazy-loaded.
//
// Real research questions hit PDFs constantly (academic papers, RFCs,
// standards bodies). Without this module, deepdive returns near-empty
// content for those URLs because the headless browser only extracts the
// rendered viewer chrome.
//
// Architectural choice: pdfjs-dist is NOT a runtime dependency of
// deepdive. It is dynamically imported the first time a PDF is fetched,
// and a clear "install pdfjs-dist to enable PDF support" message is
// surfaced if it's missing. This keeps the headline "one runtime
// dependency" accurate for default installs while making the feature
// available to anyone who wants it via:
//
//   npm install -g pdfjs-dist
//
// `deepdive doctor` reports the install state.

export interface PdfExtractOptions {
  // Cap on pages parsed. A 600-page PDF would blow the synth context.
  // Defaults to 50 — enough to cover most papers and standards docs.
  maxPages?: number;
}

export interface PdfExtractResult {
  text: string;
  pageCount: number;
  parsedPages: number;
  truncated: boolean;
}

export class PdfExtractorMissingError extends Error {
  constructor() {
    super(
      "pdfjs-dist not installed (it ships as an optional dependency — was the install run with --omit=optional?) — " +
        "install with `npm install -g pdfjs-dist` to enable PDF source support",
    );
    this.name = "PdfExtractorMissingError";
  }
}

// Lazy resolver for pdfjs-dist. Cached after the first call so we don't
// re-resolve on every PDF in a multi-PDF run. Returns null if the module
// is not installed; the caller is expected to surface a clear message.
let pdfjsCache: unknown = undefined;
async function loadPdfjs(): Promise<unknown> {
  if (pdfjsCache !== undefined) return pdfjsCache;
  try {
    // The legacy build is the only one that runs cleanly in Node without
    // configuring a worker. Keep this import path as a string literal so
    // bundlers / tsc don't try to resolve it at compile time.
    const mod = await import(
      /* @vite-ignore */ "pdfjs-dist/legacy/build/pdf.mjs"
    );
    pdfjsCache = mod;
    return mod;
  } catch {
    pdfjsCache = null;
    return null;
  }
}

// True iff pdfjs-dist is importable. Exported for doctor.
export async function isPdfExtractorAvailable(): Promise<boolean> {
  return (await loadPdfjs()) !== null;
}

// Resets the cache. Exported for tests; not used in production.
export function _resetPdfjsCache(): void {
  pdfjsCache = undefined;
}

export async function extractPdfText(
  bytes: Uint8Array,
  opts: PdfExtractOptions = {},
): Promise<PdfExtractResult> {
  const pdfjs = (await loadPdfjs()) as
    | null
    | {
        getDocument: (args: {
          data: Uint8Array;
          disableWorker?: boolean;
          isEvalSupported?: boolean;
          useSystemFonts?: boolean;
          standardFontDataUrl?: string;
        }) => {
          promise: Promise<PdfDocumentLike>;
          destroy: () => Promise<void>;
        };
        GlobalWorkerOptions?: { workerSrc?: string };
      };
  if (!pdfjs) throw new PdfExtractorMissingError();

  // pdfjs-dist's legacy build for Node still wants a worker source path
  // even when `disableWorker: true` is set — it uses it to dynamically
  // import the worker module for the "fake worker" inline path. Resolving
  // the bundled worker file once and assigning its URL satisfies that
  // requirement without spawning a real Worker thread.
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    try {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      pdfjs.GlobalWorkerOptions.workerSrc = req.resolve(
        "pdfjs-dist/legacy/build/pdf.worker.mjs",
      );
    } catch {
      // Best-effort — if resolution fails, the getDocument call below
      // will throw a clearer error with the original message.
    }
  }

  // pdfjs-dist v6 throws "Ensure that the standardFontDataUrl API parameter
  // is provided" the moment a PDF references a standard font. Resolve the
  // bundled standard_fonts directory (sibling of the legacy build) and pass
  // it below so extraction works for those PDFs. Best-effort — on failure
  // the getDocument call surfaces a clear error.
  let standardFontDataUrl: string | undefined;
  try {
    const { createRequire } = await import("node:module");
    const path = await import("node:path");
    const req = createRequire(import.meta.url);
    const pdfMjs = req.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    const pkgRoot = path.resolve(path.dirname(pdfMjs), "..", "..");
    standardFontDataUrl =
      path.join(pkgRoot, "standard_fonts").replace(/\\/g, "/") + "/";
  } catch {
    // ignore — getDocument surfaces a clear error if fonts are then needed
  }

  const maxPages = Math.max(1, opts.maxPages ?? 50);

  // pdfjs-dist mutates the buffer it parses; pass a copy so cache
  // round-trips don't corrupt across uses.
  const buf = bytes.slice();
  // Keep the loading task: pdfjs v6 removed PDFDocumentProxy.destroy(), so
  // teardown goes through loadingTask.destroy() (stable across versions).
  const loadingTask = pdfjs.getDocument({
    data: buf,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl,
  });
  const doc = await loadingTask.promise;

  const pageCount = doc.numPages;
  const parsedPages = Math.min(pageCount, maxPages);
  const pageTexts: string[] = [];
  for (let i = 1; i <= parsedPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pageTexts.push(joinTextItems(content.items));
  }
  await loadingTask.destroy().catch(() => undefined);

  const text = dedupeRunningHeadersFooters(pageTexts).join("\n\n");
  return {
    text,
    pageCount,
    parsedPages,
    truncated: parsedPages < pageCount,
  };
}

interface PdfDocumentLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageLike>;
}
interface PdfPageLike {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
}
interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

// Exported for unit tests. Joins a page's text-content items into
// readable prose, emitting a single space between items unless the item
// signals a hard line break via `hasEOL`.
export function joinTextItems(items: PdfTextItem[]): string {
  const out: string[] = [];
  for (const item of items) {
    const s = item.str ?? "";
    if (!s && !item.hasEOL) continue;
    if (item.hasEOL) {
      out.push(s);
      out.push("\n");
    } else {
      out.push(s);
      out.push(" ");
    }
  }
  return collapseWhitespace(out.join(""));
}

// Exported for unit tests. Drops lines that appear on >= 60% of pages
// (running headers / footers / page numbers). Frequency-based — does
// nothing on single-page PDFs.
export function dedupeRunningHeadersFooters(pages: string[]): string[] {
  if (pages.length < 3) return pages;
  const lineCounts = new Map<string, number>();
  for (const page of pages) {
    const seenInPage = new Set<string>();
    for (const line of page.split(/\n+/)) {
      const norm = normalizeForDedup(line);
      if (!norm) continue;
      if (seenInPage.has(norm)) continue;
      seenInPage.add(norm);
      lineCounts.set(norm, (lineCounts.get(norm) ?? 0) + 1);
    }
  }
  const cutoff = Math.ceil(pages.length * 0.6);
  const drop = new Set<string>();
  for (const [line, count] of lineCounts) {
    if (count >= cutoff) drop.add(line);
  }
  if (drop.size === 0) return pages;
  return pages.map((p) =>
    p
      .split(/\n+/)
      .filter((line) => !drop.has(normalizeForDedup(line)))
      .join("\n"),
  );
}

function normalizeForDedup(line: string): string {
  // Treat "Page 5" and "Page 12" as different (they correctly count
  // distinctly) but ignore leading/trailing whitespace.
  return line.trim().replace(/\s+/g, " ").toLowerCase();
}

function collapseWhitespace(s: string): string {
  // Per-line normalization avoids the polynomial backtracking that
  // ` *\n */g` would do on inputs with long horizontal whitespace
  // runs and no newlines (CodeQL flagged the earlier form). Every
  // operation here is single-pass linear: split → trim → filter.
  const lines = s.split(/\r?\n/).map((line) =>
    line.replace(/[ \t\f\v]+/g, " ").trim(),
  );
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === "") {
      blanks++;
      if (blanks <= 1) out.push("");
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  return out.join("\n").trim();
}

// Returns true when the URL or content-type plausibly points at a PDF.
// Exported for unit tests and for browser.ts integration.
export function looksLikePdf(args: {
  url?: string;
  finalUrl?: string;
  contentType?: string;
}): boolean {
  const ct = (args.contentType ?? "").toLowerCase();
  if (ct.startsWith("application/pdf")) return true;
  for (const u of [args.finalUrl, args.url]) {
    if (!u) continue;
    const lower = u.toLowerCase().split(/[?#]/)[0];
    if (lower.endsWith(".pdf")) return true;
  }
  return false;
}
