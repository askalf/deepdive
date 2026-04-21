// Library exports for programmatic use.

export { runAgent, type AgentConfig, type AgentEvent, type AgentResult } from "./agent.js";
export { planQueries, parsePlan, type Plan } from "./plan.js";
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
export { callLLM, type LLMConfig, type LLMMessage, type LLMResult } from "./llm.js";
export { resolveConfig, type RuntimeConfig, type CLIFlags } from "./config.js";
