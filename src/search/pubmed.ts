// PubMed search adapter. No API key (NCBI E-utilities allow ~3 req/s
// unauthenticated). Two-step: esearch returns matching PMIDs, esummary
// returns their metadata. A fit for biomedical / life-sciences questions
// where peer-reviewed literature is the authoritative source. The kept source
// is the PubMed abstract page.

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

interface ESummaryDoc {
  uid?: string;
  title?: string;
  pubdate?: string;
  source?: string;
  authors?: { name?: string }[];
}

export class PubMedSearch implements SearchAdapter {
  readonly name = "pubmed";
  // Results are constructed pubmed.ncbi.nlm.nih.gov/<id>/ URLs — #147.
  readonly servesDomains = ["pubmed.ncbi.nlm.nih.gov"];

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const n = Math.min(Math.max(limit, 1), 50);
    const sig = searchTimeoutSignal(signal);

    const esearch = new URL(`${BASE}/esearch.fcgi`);
    esearch.searchParams.set("db", "pubmed");
    esearch.searchParams.set("term", query);
    esearch.searchParams.set("retmax", String(n));
    esearch.searchParams.set("retmode", "json");
    esearch.searchParams.set("sort", "relevance");
    const sres = await fetch(esearch, {
      headers: { accept: "application/json", "user-agent": "deepdive (+https://github.com/askalf/deepdive)" },
      signal: sig,
    });
    if (!sres.ok) throw new Error(`pubmed esearch ${sres.status} ${sres.statusText}`);
    const sjson = (await sres.json()) as { esearchresult?: { idlist?: string[] } };
    const ids = sjson.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];

    const esummary = new URL(`${BASE}/esummary.fcgi`);
    esummary.searchParams.set("db", "pubmed");
    esummary.searchParams.set("id", ids.join(","));
    esummary.searchParams.set("retmode", "json");
    const ures = await fetch(esummary, {
      headers: { accept: "application/json", "user-agent": "deepdive (+https://github.com/askalf/deepdive)" },
      signal: sig,
    });
    if (!ures.ok) throw new Error(`pubmed esummary ${ures.status} ${ures.statusText}`);
    const ujson = (await ures.json()) as { result?: Record<string, unknown> };
    return mapPubMedSummary(ujson.result ?? {}, ids, limit);
  }
}

// Exported for unit tests. Pure mapper over the esummary `result` map, in the
// PMID order esearch returned. Builds the abstract URL and a journal/date/
// author snippet.
export function mapPubMedSummary(
  result: Record<string, unknown>,
  ids: string[],
  limit: number,
): SearchResult[] {
  const out: SearchResult[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const doc = result[id] as ESummaryDoc | undefined;
    if (!doc || typeof doc.title !== "string" || doc.title.length === 0) continue;
    out.push({
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      title: doc.title.replace(/\.$/, ""),
      snippet: pubmedSnippet(doc),
      rank: out.length + 1,
    });
  }
  return out;
}

function pubmedSnippet(doc: ESummaryDoc): string {
  const parts: string[] = [];
  const authors = (doc.authors ?? []).map((a) => a.name).filter(Boolean);
  if (authors.length > 0) {
    parts.push(authors.length > 3 ? `${authors.slice(0, 3).join(", ")}, et al.` : authors.join(", "));
  }
  if (doc.source) parts.push(doc.source);
  if (doc.pubdate) parts.push(doc.pubdate);
  return parts.join(" · ");
}
