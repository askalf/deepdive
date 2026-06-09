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
export { synthesize, type SourceWithContent, type SynthesizeOptions } from "./synthesize.js";
export {
  extractPublishedDate,
  metaTags,
  jsonLdDates,
  toEpoch,
  resolveSince,
} from "./dates.js";
export {
  assessConfidence,
  formatConfidenceLine,
  type ConfidenceLevel,
  type ConfidenceInput,
  type ConfidenceAssessment,
} from "./confidence.js";
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
export { callLLMStream, parseBlocks, parseSSE, type StreamOptions } from "./llm-stream.js";
export { retry, backoffDelay, type RetryOptions } from "./retry.js";
export { resolveConfig, type RuntimeConfig, type CLIFlags } from "./config.js";
export {
  loadConfigFile,
  fileConfigToEnv,
  knownConfigKeys,
  defaultConfigPath,
  type FileConfig,
  type ParsedConfigFile,
} from "./config-file.js";
export { BUILTIN_PROFILES, resolveProfile, listProfiles } from "./profiles.js";
export { completionScript, type Shell } from "./completion.js";
export { createCache, cacheKey, type PageCache, type CacheOptions } from "./cache.js";
export { runConcurrent } from "./concurrency.js";
export {
  priceFor,
  estimateCost,
  formatCostLine,
  formatUsd,
  formatTokens,
  looksLikeDario,
  daysAgo,
  PRICE_TABLE,
  PRICE_TABLE_VERIFIED_AT,
  PRICE_TABLE_STALE_AFTER_DAYS,
  DARIO_DEFAULT_BASE_URL,
  type ModelPrice,
  type TokenUsage,
  type CostEstimate,
} from "./pricing.js";
export {
  extractPdfText,
  isPdfExtractorAvailable,
  looksLikePdf,
  joinTextItems,
  dedupeRunningHeadersFooters,
  PdfExtractorMissingError,
  type PdfExtractOptions,
  type PdfExtractResult,
} from "./pdf.js";
export {
  ingestLocalPaths,
  expandPaths,
  stripTags,
  type LocalIngestOptions,
  type LocalIngestResult,
} from "./local.js";
export {
  classifyUrl,
  matchesAny,
  normalizePattern,
  parseDomainList,
  type DomainFilter,
  type DomainVerdict,
} from "./domain-filter.js";
export {
  generateSessionId,
  saveSession,
  loadSession,
  listSessions,
  resolveSessionId,
  renderSessionsList,
  defaultSessionsDir,
  humanDuration,
  deleteSession,
  pruneSessions,
  selectSessionsToPrune,
  parseDuration,
  type SessionRecord,
  type SessionMeta,
  type SessionStorageOptions,
  type PruneCriteria,
} from "./sessions.js";
export {
  markdownToHtml,
  renderInline,
  escapeHtml,
  type MarkdownToHtmlOptions,
} from "./markdown.js";
export {
  renderHtmlReport,
  type HtmlReportOptions,
} from "./html-export.js";
export {
  diffSessions,
  diffSources,
  diffLines,
  renderDiffText,
  buildDiffNarrateUser,
  DIFF_NARRATE_SYSTEM,
  type SessionDiff,
  type SourceRef,
  type DiffLine,
  type LineKind,
  type SessionSide,
  type RenderDiffOptions,
} from "./diff.js";
export {
  detectApiFormat,
  toOpenAIRequest,
  fromOpenAIResponse,
  openaiSSEToAnthropic,
  authHeadersFor,
  pathFor,
  type ApiFormat,
  type AnthropicRequestBody,
  type OpenAIRequestBody,
  type AnthropicResponseShape,
  type OpenAIResponseShape,
  type AnthropicSSEEvent,
  type OpenAIStreamEvent,
} from "./llm-format.js";
export {
  verifyCitations,
  splitSentences,
  extractCiteIds,
  contentTokens,
  recall,
  stripSourcesBlock,
  DEFAULT_CITE_MIN_RECALL,
  type CitationCheck,
  type VerificationReport,
  type VerifyOptions,
} from "./verify.js";
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
