export * from './types.js';
export { loadConfig, defineConfig } from './config.js';
export type { Config } from './config.js';
export { runPipeline, PipelineItemError } from './pipeline.js';
export type { RunOptions, RunOverrides } from './pipeline.js';
export { normalizeLanguageCodes } from './validation.js';

// Auth surface — let consumers pick credential / apiKey / default mode.
export type { LectoriaAuth } from './azure-auth.js';
export { COGNITIVE_SERVICES_SCOPE, resolveCredential } from './azure-auth.js';

// Logger surface — library code stays silent by default; CLIs/host apps
// install a real logger.
export { noopLogger, createStreamLogger } from './logger.js';
export type { Logger } from './logger.js';

// Default Azure-backed adapters. Each is also reachable via subpath import
// (lectoria/script, lectoria/synthesize, lectoria/package, lectoria/distribute)
// for tree-shaking-friendly consumers.
export { AzureOpenAIScriptModel } from './script/index.js';
export type { AzureOpenAIScriptModelOptions } from './script/index.js';
export { AzureSpeechTts } from './synthesize/index.js';
export type { AzureSpeechTtsOptions } from './synthesize/index.js';
export { Id3Packager } from './package/index.js';
export { RssDistributor } from './distribute/index.js';
export type { RssDistributorOptions } from './distribute/index.js';

// Stage primitives so library consumers can compose sub-pipelines.
export { ingest, LocalFileSystemIngest } from './ingest/index.js';
export {
  parse,
  defaultParsers,
  PdfParser,
  DocxParser,
  MarkdownParser,
  HtmlParser,
  TextParser,
} from './parse/index.js';
export type { ParseOptions } from './parse/index.js';
export { translateToAll } from './translate/index.js';

// Glossary helpers — apply project-specific terms outside the pipeline
// (e.g. wrap an externally-authored script before handing it to a custom
// TTS adapter).
export {
  applyGlossaryToScript,
  applyGlossaryMarkers,
  normalizeGlossary,
  renderGlossaryForPrompt,
} from './script/glossary.js';
export type { NormalizedGlossaryTerm } from './script/glossary.js';

// Lightweight TTS factory — use this when you already have the text you
// want spoken and don't need the full doc-to-podcast pipeline.
export { createTTS } from './factory.js';
export type { CreateTtsOptions, SpeakOptions, SpeakResult, TtsClient } from './factory.js';

// Cost estimation — preview tokens, characters, and USD before running.
export { estimateCost, DEFAULT_PRICING } from './estimate.js';
export type {
  EstimateInput,
  EstimateOptions,
  EstimateResult,
  LanguageEstimate,
  PricingTable,
} from './estimate.js';
export {
  DEFAULT_COST_POLICY,
  CostLimitExceededError,
  CostApprovalRequiredError,
  CostApprovalDeclinedError,
  createCostAssessment,
  enforceCostPolicy,
  formatCostAssessment,
  resolveCostPolicy,
} from './cost-policy.js';
export type {
  CostAssessment,
  CostAwarenessMode,
  CostPolicy,
  ResolvedCostPolicy,
} from './cost-policy.js';
