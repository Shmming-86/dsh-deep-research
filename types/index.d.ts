/**
 * Type declarations for @shmming/dsh-deep-research.
 *
 * The plugin is plain ESM; this file describes its Cordis plugin surface for
 * editors and TypeScript consumers. Runtime behavior is owned by `src/index.js`.
 *
 * @module @shmming/dsh-deep-research
 */

import type { Context } from '@deepseek-ai/cordis'

/** Optional plugin configuration (all fields optional). */
export interface DeepResearchConfig {
  /** Child-provider name used for every activation. Default: `spawn`. */
  childProvider?: string
  /** Research children per round (positive integer). Default: 4. */
  maxParallel?: number
  /** Hard cap on child activations started by one tool call. Default: 32. */
  maxTotalAgents?: number
  /** Model override for the planner child. */
  plannerModel?: string
  /** Model override for research children. */
  researcherModel?: string
  /** Model override for the synthesizer child. */
  synthesizerModel?: string
  /** Model override for the reviewer child (falls back to `synthesizerModel`). */
  reviewerModel?: string
}

/** Cordis plugin name used by loader diagnostics. */
export declare const name: 'dsh-deep-research'

/** Services required before the plugin activates. */
export declare const inject: readonly ['tools', 'subagents']

/** Schemastery object schema describing {@link DeepResearchConfig}. */
export declare const Config: Record<string, unknown>

/**
 * Register the `deep_research` tool on `ctx.tools`.
 * @param ctx - Cordis context providing `tools` and `subagents`.
 * @param config - optional plugin configuration.
 */
export declare function apply(ctx: Context, config?: DeepResearchConfig): void
