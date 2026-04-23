// Library exports for programmatic use.

export {
  runAgent,
  type AgentConfig,
  type AgentEvent,
  type AgentResult,
  type BrowserLike,
  type RoundTrace,
} from "./agent.js";
export {
  planQueries,
  parsePlan,
  critique,
  parseCritique,
  type Plan,
  type Critique,
} from "./plan.js";
export {
  resolveSearchAdapter,
  dedupeByUrl,
  type SearchAdapter,
  type SearchResult,
} from "./search.js";
export { BrowserSession, type BrowserOptions, type FetchedPage } from "./browser.js";
export { extractContent, type ExtractedContent } from "./extract.js";
export { synthesize, type SourceWithContent } from "./synthesize.js";
export {
  buildSourceTable,
  renderAnswerMarkdown,
  renderSourcesMarkdown,
  type Source,
} from "./citations.js";
export {
  callLLM,
  LLMError,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_ATTEMPTS,
  type LLMConfig,
  type LLMMessage,
  type LLMResult,
} from "./llm.js";
export { retry, backoffDelay, type RetryOptions } from "./retry.js";
export { resolveConfig, type RuntimeConfig, type CLIFlags } from "./config.js";
export { createCache, cacheKey, type PageCache, type CacheOptions } from "./cache.js";
export { runConcurrent } from "./concurrency.js";
export { trimTrailingSlashes, stripHashFragment, dedupeKey } from "./url-util.js";
export {
  runDoctor,
  renderDoctorText,
  renderDoctorJson,
  exitCodeFor,
  scrubPath,
  formatBytes,
  formatDuration,
  classifyFetchError,
  nodeMeetsMinimum,
  type CheckResult,
  type CheckStatus,
  type DoctorReport,
  type DoctorOptions,
} from "./doctor.js";
