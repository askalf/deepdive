// Aggregate insights across saved sessions — what have I researched, how much
// has it cost, which models did the work. Pure over a list of SessionRecords
// (the CLI reads them); rendering is separate so it's unit-testable.

import type { SessionRecord } from "./sessions.js";

export interface ModelStat {
  model: string;
  count: number;
  costUsd: number;
}

export interface SessionStats {
  count: number;
  totalCostUsd: number;
  totalSources: number;
  totalRounds: number;
  deepRuns: number; // sessions that ran more than one round
  avgSourcesPerSession: number;
  byModel: ModelStat[]; // sorted by count desc
  oldest?: number; // createdAt epoch ms
  newest?: number;
}

export function aggregateSessionStats(records: SessionRecord[]): SessionStats {
  const byModel = new Map<string, ModelStat>();
  let totalCostUsd = 0;
  let totalSources = 0;
  let totalRounds = 0;
  let deepRuns = 0;
  let oldest: number | undefined;
  let newest: number | undefined;

  for (const r of records) {
    const cost = typeof r.cost?.amountUsd === "number" ? r.cost.amountUsd : 0;
    totalCostUsd += cost;
    totalSources += r.sources?.length ?? 0;
    const rounds = r.rounds?.length ?? 0;
    totalRounds += rounds;
    if (rounds > 1) deepRuns++;

    const model = r.llm?.model ?? "(unknown)";
    let bucket = byModel.get(model);
    if (!bucket) {
      bucket = { model, count: 0, costUsd: 0 };
      byModel.set(model, bucket);
    }
    bucket.count++;
    bucket.costUsd += cost;

    if (typeof r.createdAt === "number") {
      if (oldest === undefined || r.createdAt < oldest) oldest = r.createdAt;
      if (newest === undefined || r.createdAt > newest) newest = r.createdAt;
    }
  }

  const models = Array.from(byModel.values()).sort(
    (a, b) => b.count - a.count || b.costUsd - a.costUsd,
  );

  return {
    count: records.length,
    totalCostUsd,
    totalSources,
    totalRounds,
    deepRuns,
    avgSourcesPerSession: records.length > 0 ? totalSources / records.length : 0,
    byModel: models,
    oldest,
    newest,
  };
}

// Exported for unit tests. Human-readable summary block.
export function renderStats(stats: SessionStats): string {
  if (stats.count === 0) {
    return "(no sessions yet — run `deepdive \"<question>\"` to create one)";
  }
  const lines: string[] = [];
  lines.push(`sessions   ${stats.count}`);
  lines.push(
    `cost       ~$${stats.totalCostUsd.toFixed(stats.totalCostUsd < 0.01 ? 4 : 2)} total (calculated at list price)`,
  );
  lines.push(
    `sources    ${stats.totalSources} fetched · ${stats.avgSourcesPerSession.toFixed(1)} avg/session`,
  );
  lines.push(
    `rounds     ${stats.totalRounds} total · ${stats.deepRuns} deep run${stats.deepRuns === 1 ? "" : "s"}`,
  );
  if (stats.oldest !== undefined && stats.newest !== undefined) {
    lines.push(`span       ${isoDay(stats.oldest)} → ${isoDay(stats.newest)}`);
  }
  if (stats.byModel.length > 0) {
    lines.push("models");
    for (const m of stats.byModel) {
      lines.push(
        `  ${m.model.padEnd(22)} ${String(m.count).padStart(4)} run${m.count === 1 ? " " : "s"} · ~$${m.costUsd.toFixed(m.costUsd < 0.01 ? 4 : 2)}`,
      );
    }
  }
  return lines.join("\n");
}

function isoDay(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "?" : d.toISOString().slice(0, 10);
}
