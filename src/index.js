/**
 * dsh-deep-research — Deep Research orchestrator extension for DeepSeek Harness 0.2.1.
 *
 * A REAL plugin (not a skill): registers one model-facing tool, `deep_research`,
 * that runs an adaptive deep-research loop. Ported from the reference project
 * `omdsh-dev/dsh-deep-research`, which targeted an older DSH API
 * (`ctx.workflows` + a workflow script). On DSH 0.2.1-rc.3 the workflow engine is
 * `ctx.workflowEngine` and the shipped `web` composition mounts it only inside
 * agent-preset delegation groups (`isolate: { workflowEngine: true }`), so a
 * root-level plugin cannot depend on it. This port therefore orchestrates on the
 * official subagent seam (`ctx.subagents.startActivation`) — the same seam the
 * workflow engine itself uses — which is provided at the root of both the `web`
 * and `headless` compositions.
 *
 * The pipeline is a LIVE ADAPTIVE LOOP designed from cybernetics + information
 * theory — it is NOT a fixed four-stage prompt chain:
 *
 * ── 问题定义 (control theory: reference-signal calibration) ────────────────
 *   The planner first defines the ANSWER SPACE (`scope`: what decision the
 *   report supports) and per-question acceptance criteria, so the loop never
 *   chases a mis-set reference.
 *
 * ── 多样性拆解 (Ashby's Law of Requisite Variety) ──────────────────────────
 *   The planner enumerates the topic's information DIMENSIONS, maps each
 *   sub-question to a dimension, and self-audits COVERAGE (`coverage_gaps`):
 *   uncovered dimensions are declared as hypotheses to be tested, not hidden.
 *
 * ── 自适应研究循环 (adaptive control / perception–action cycle) ────────────
 *   Research is an ITERATIVE CLOSED LOOP, not a one-shot fan-out:
 *     round 1:  all planned sub-questions, `maxParallel` at a time.
 *     round n>1: dynamic re-planning — high-priority gaps reported by the
 *                previous round become NEW sub-questions, and the planner's
 *                declared blind spots get one reconnaissance attempt (a
 *                planning assumption is verified experimentally, not trusted).
 *   Convergence is information-theoretic: the loop stops when a round produces
 *   no new high-priority gaps (marginal information gain ≈ 0) or the round cap
 *   (depth + 1) is hit. Simple topics converge after one round; hard ones
 *   automatically expand — the flow is alive, not a fixed script.
 *
 * ── 综合 (rate–distortion) ─────────────────────────────────────────────────
 *   The final report is lossy compression for a stated decision: it keeps only
 *   information that distinguishes conclusions, and PRESERVES uncertainty
 *   (confidence / 矛盾 / verified blind spots) instead of masking it.
 *
 * ── 审查 (channel redundancy / error correction, opt-in) ───────────────────
 *   An adversarial reviewer acts as a parity check: citation spot-checks
 *   (hallucinated sources = channel noise), coverage audit against the declared
 *   dimensions, contradiction and over-confidence marking.
 *
 * Model tiering via config: `plannerModel` / `researcherModel` /
 * `synthesizerModel` / `reviewerModel` -> per-child `agentOptions.model`;
 * omitted models inherit the parent route. The plugin never fetches the web:
 * search/fetch stays on DSH's built-in `web_search` / `web_fetch`, which
 * children inherit from their parent preset.
 *
 * Cancellation: `exec.signal` is forwarded to every activation; an abort disposes
 * the live child and the tool call rejects with the abort reason. Every
 * activation is disposed exactly once on every path.
 *
 * @module @shmming/dsh-deep-research
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-deep-research'

/**
 * Activate once the tool registry and the official subagent seam are available.
 * Both are provided at the root of the shipped `web` and `headless` profiles.
 */
export const inject = ['tools', 'subagents']

/** Plugin config (all optional; `apply` re-validates because direct callers bypass schemastery defaults). */
export const Config = z.object({
  /** Child-provider name used for every activation (default `spawn`). */
  childProvider: z.string().default('spawn'),
  /** Research children per round (positive integer, default 4). */
  maxParallel: z.number().default(4),
  /** Hard cap on child activations started by one tool call (positive integer, default 32). */
  maxTotalAgents: z.number().default(32),
  /** Model override for the planner child. */
  plannerModel: z.string(),
  /** Model override for research children. */
  researcherModel: z.string(),
  /** Model override for the synthesizer child. */
  synthesizerModel: z.string(),
  /** Model override for the reviewer child (falls back to `synthesizerModel`). */
  reviewerModel: z.string(),
})

/**
 * Planner structured output (raw JSON Schema — the subagent `outputSchema`
 * subset: object root, `required` as an array of strings, annotation keywords
 * only). Answer space + dimension coverage + sub-questions.
 */
const PLANNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string', description: '答案空间：这份研究要回答什么、支撑什么判断/决策' },
    dimensions: { type: 'array', items: { type: 'string' }, description: '主题的信息维度' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          dimension: { type: 'string' },
          keywords: { type: 'string' },
          acceptance: { type: 'string' },
        },
        required: ['question', 'dimension'],
      },
    },
    coverage_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['scope', 'dimensions', 'questions', 'coverage_gaps'],
}

/**
 * Researcher structured output: the three-state evidence model (entropy
 * tracking). `confirmed` / `uncertain` / `gaps` make conditional entropy
 * explicit; high-priority gaps drive the next adaptive round.
 */
const RESEARCHER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    confirmed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          source: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['claim', 'source'],
      },
    },
    uncertain: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          point: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['point'],
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          aspect: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['aspect'],
      },
    },
  },
  required: ['confirmed'],
}

/** Thrown internally when the run's total-child budget is exhausted. */
class BudgetExceeded extends Error {
  constructor(limit) {
    super(`dsh-deep-research: reached maxTotalAgents (${limit})`)
    this.name = 'BudgetExceeded'
  }
}

/**
 * Apply the plugin: register the `deep_research` tool on `ctx.tools`.
 * @param ctx - cordis context providing `tools` and `subagents`.
 * @param config - plugin config; every field is optional and re-validated here.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)

  ctx.tools.register(defineTool({
    name: 'deep_research',
    description:
      '深度研究编排工具（Deep Research Orchestrator，基于 DSH 官方 subagent 委派 seam，按控制论与'
      + '信息论设计的自适应流程）。当用户要求对复杂主题做深度研究/调研（需要多源信息搜集、'
      + '交叉验证、撰写调研报告）时调用。流程是活的，不是固定脚本：规划子代理先定义答案空间、'
      + '按信息维度拆解子问题并声明盲区假设 → 研究阶段是自适应闭环——每轮并行研究子问题，'
      + '每轮结束收集高优先级信息缺口，自动派发下一轮补充研究（规划盲区也会被定向侦察验证），'
      + '直到某一轮边际信息增益为零或达到轮次上限（简单主题一轮收敛，复杂主题自动扩展）→ '
      + '综合子代理按率失真原则压缩为最终报告（保留不确定性与已验证盲区）→ 可选对抗性审查'
      + '（引用纠错 + 覆盖度审计）。子代理继承本次会话的内置 web_search/web_fetch 工具。'
      + '触发场景：深度研究、调研、多源信息综合分析、研究报告、文献/资料搜集。若需求模糊，'
      + '先向用户澄清（用途/范围）再调用；若你已有具体问题清单，直接传 questions 可跳过自动拆解。',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: '研究主题。',
      },
      purpose: {
        type: 'string',
        description: '可选：研究用途——这份研究要支撑什么判断/决策。用于定义答案空间；缺省时规划子代理会声明假设的用途。',
      },
      questions: {
        type: 'string',
        description: '可选：已有研究问题清单（每行一个，或 1. 2. 3. 编号）。提供后跳过自动拆解阶段。',
      },
      depth: {
        type: 'number',
        description: '研究精度（容差）：1=初步（研究闭环最多2轮），2=深入（默认，最多3轮），3=穷尽（最多4轮）。',
      },
      synthesize: {
        type: 'boolean',
        description: '是否让综合子代理撰写最终报告（默认 true）。false 时只返回各子问题的三态证据，由你撰写。',
      },
      review: {
        type: 'boolean',
        description: '是否让审阅子代理做对抗性审查（默认 false）：引用纠错、覆盖度审计、矛盾与过度自信标注，并给出需要补充研究的最高优先级缺口。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
          review: { type: 'string' },
          rounds: { type: 'number' },
          subquestions: { type: 'number' },
          completed: { type: 'number' },
          failed: { type: 'number' },
          skipped: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.review !== undefined ? `${value.report}\n\n${value.review}` : value.report)
          : `deep_research 未能完成研究：${value.report}`,
      }],
    },
    async execute(args, exec) {
      return runDeepResearch(ctx, settings, args, exec)
    },
  }))

  ctx.logger?.info?.(
    `dsh-deep-research: registered deep_research tool (provider=${settings.childProvider}, `
    + `maxParallel=${settings.maxParallel}, maxTotalAgents=${settings.maxTotalAgents}).`,
  )
}

/**
 * Resolve and validate plugin config. Direct `apply()` callers bypass schemastery
 * defaults, so every value is resolved here as well.
 * @param config - raw plugin config.
 * @returns normalized settings.
 */
function resolveSettings(config) {
  const childProvider = typeof config.childProvider === 'string' && config.childProvider.trim().length > 0
    ? config.childProvider.trim()
    : 'spawn'
  const maxParallel = positiveInt(config.maxParallel, 4, 'maxParallel')
  const maxTotalAgents = positiveInt(config.maxTotalAgents, 32, 'maxTotalAgents')
  if (maxTotalAgents < 2) {
    throw new Error('dsh-deep-research: maxTotalAgents must be at least 2 (plan/research plus synthesis)')
  }
  const model = (value, label) => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`dsh-deep-research: ${label} must be a non-empty string`)
    }
    return value.trim()
  }
  const synthesizerModel = model(config.synthesizerModel, 'synthesizerModel')
  return {
    childProvider,
    maxParallel,
    maxTotalAgents,
    plannerModel: model(config.plannerModel, 'plannerModel'),
    researcherModel: model(config.researcherModel, 'researcherModel'),
    synthesizerModel,
    reviewerModel: model(config.reviewerModel, 'reviewerModel') ?? synthesizerModel,
  }
}

/**
 * Execute one `deep_research` call.
 * @param ctx - plugin context.
 * @param cfg - normalized settings.
 * @param args - validated tool arguments.
 * @param exec - tool execution context (agent + cooperative cancellation).
 * @returns the declared canonical output value.
 */
async function runDeepResearch(ctx, cfg, args, exec) {
  const parent = exec.agent
  if (parent === undefined) {
    throw new Error('deep_research requires a calling agent (exec.agent was undefined)')
  }
  const topic = typeof args.topic === 'string' ? args.topic.trim() : ''
  if (topic.length === 0) throw new Error('deep_research: topic must not be empty')
  const purpose = typeof args.purpose === 'string' && args.purpose.trim().length > 0
    ? args.purpose.trim()
    : undefined
  const depth = args.depth === undefined ? 2 : positiveInt(args.depth, 2, 'depth')
  if (depth > 3) throw new Error('dsh-deep-research: depth must be 1, 2 or 3 (1=初步，2=深入，3=穷尽)')
  const synthesize = args.synthesize !== false
  const review = args.review === true
  const givenQuestions = parseQuestionList(args.questions)

  const synthBudget = synthesize ? 1 : 0
  const reviewBudget = review ? 1 : 0
  const plannerBudget = givenQuestions.length > 0 ? 0 : 1
  const minimumBudget = plannerBudget + synthBudget + reviewBudget + 1
  if (cfg.maxTotalAgents < minimumBudget) {
    throw new Error(
      `dsh-deep-research: maxTotalAgents=${cfg.maxTotalAgents} is too small for this run `
      + `(needs at least ${minimumBudget}: planner/research plus synthesis/review)`,
    )
  }
  /** Total activations started plus the research budget reserved for rounds. */
  const state = { started: 0, limit: cfg.maxTotalAgents }
  const researchBudget = cfg.maxTotalAgents - plannerBudget - synthBudget - reviewBudget

  /** Run one child and normalize its outcome; abort and budget faults propagate. */
  const runChild = async ({ label, prompt, schema, model }) => {
    exec.signal?.throwIfAborted?.()
    if (state.started >= state.limit) throw new BudgetExceeded(state.limit)
    state.started += 1
    // The seam is async: `startActivation` resolves only after the child is
    // published and cancellable (dsh-subagent types: Promise<SubagentActivation>).
    let activation
    try {
      activation = await ctx.subagents.startActivation({
        provider: cfg.childProvider,
        label,
        delivery: 'caller',
        signal: exec.signal,
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent,
          ...(schema !== undefined ? { outputSchema: schema } : {}),
          ...(model !== undefined ? { agentOptions: { model } } : {}),
        },
      })
    } catch (error) {
      if (exec.signal?.aborted) throw abortReason(exec.signal)
      throw new Error(`deep_research: 子代理启动失败（${label}）：${String(error)}`)
    }
    // The seam's dispose() is idempotent; this wrapper also keeps the abort path
    // and the normal path from issuing duplicate cleanup work.
    let disposePromise
    const disposeOnce = () => {
      // Defer the call so a synchronous throw from dispose() cannot mask the outcome.
      disposePromise ??= Promise.resolve().then(() => activation.dispose()).catch(() => {})
      return disposePromise
    }
    const onAbort = () => { void disposeOnce() }
    exec.signal?.addEventListener?.('abort', onAbort, { once: true })
    // A signal that aborted while the activation was being published cannot
    // reach the listener above; dispose here instead of waiting forever.
    if (exec.signal?.aborted) {
      await disposeOnce()
      throw abortReason(exec.signal)
    }
    try {
      let result
      try {
        result = await activation.result
      } catch (error) {
        if (exec.signal?.aborted) throw abortReason(exec.signal)
        return { ok: false, error: String(error) }
      }
      const text = Array.isArray(result?.output)
        ? result.output.filter(block => block?.type === 'text').map(block => block.text).join('')
        : ''
      // A schema-requested child that ends without a structured value produced
      // no usable result (mirrors the workflow engine's `agent()` -> null rule).
      const ok = result?.stopReason === 'completed'
        && (schema === undefined || result.structured !== undefined)
      return {
        ok,
        structured: ok ? result.structured : undefined,
        text,
        ...(result?.diagnostic !== undefined ? { diagnostic: String(result.diagnostic) } : {}),
      }
    } finally {
      exec.signal?.removeEventListener?.('abort', onAbort)
      await disposeOnce()
      if (exec.signal?.aborted) throw abortReason(exec.signal)
    }
  }

  // ── 规划：答案空间 + 信息维度 + 子问题 + 盲区假设 ────────────────────────────
  let planText = ''
  let subs
  if (givenQuestions.length > 0) {
    // `parseQuestionList` already returns `{ question }` entries; keeping them
    // as-is preserves any dimension/keywords/acceptance fields for the prompts.
    subs = givenQuestions.map(item => ({ ...item }))
  } else {
    let planned
    try {
      planned = await runChild({
        label: '规划',
        prompt: plannerPrompt(topic, purpose),
        schema: PLANNER_SCHEMA,
        model: cfg.plannerModel,
      })
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        throw new Error('deep_research: 无法启动规划子代理（达到 maxTotalAgents 上限）')
      }
      throw error
    }
    if (!planned.ok || !planned.structured || !Array.isArray(planned.structured.questions) || planned.structured.questions.length === 0) {
      throw new Error('deep_research: 规划子代理未返回有效的结构化子问题（可改用 questions 参数直接给出问题清单）')
    }
    subs = planned.structured.questions
    const dimensions = Array.isArray(planned.structured.dimensions) ? planned.structured.dimensions : []
    const gaps = Array.isArray(planned.structured.coverage_gaps) ? planned.structured.coverage_gaps : []
    planText = '研究答案空间：' + (planned.structured.scope || '（未声明）')
      + '\n覆盖维度：' + (dimensions.length > 0 ? dimensions.join('、') : '（未声明）')
      + (gaps.length > 0 ? '\n规划假设的盲区（待验证）：' + gaps.join('、') : '')
    // 规划的盲区作为假设进入研究队列，绝不静默丢弃。
    subs = subs.concat(gaps.map(gap => ({ question: gap, dimension: '盲区侦察', blind: true })))
  }

  const queued = new Set(subs.map(item => item.question))
  let pending = subs.slice()
  let round = 0
  const results = new Map()
  const rounds = []
  const maxRounds = depth + 1

  // ── 自适应研究闭环 ─────────────────────────────────────────────────────────
  while (pending.length > 0 && round < maxRounds && state.started < state.limit) {
    // Budget reserved for synthesis/review must never be consumed by research rounds.
    const researchRemaining = researchBudget - (state.started - plannerBudget)
    const remainingBudget = Math.min(researchRemaining, state.limit - state.started)
    if (remainingBudget < 1) break
    round += 1
    const width = Math.max(1, Math.min(cfg.maxParallel, remainingBudget, pending.length))
    const batch = pending.slice(0, width)
    pending = pending.slice(width)
    const found = await runResearchRound(runChild, batch, width, {
      topic,
      purpose,
      round,
      model: cfg.researcherModel,
    })
    batch.forEach((item, index) => {
      if (found[index]?.ok) results.set(item.question, found[index])
    })
    rounds.push(batch.map((item, index) => ({ question: item, finding: found[index] })))

    // 收敛评估：本轮 high-priority 缺口 → 下一轮动态补充（跨轮去重，绝不静默丢弃）。
    const leads = []
    for (const finding of found) {
      if (!finding?.ok || !Array.isArray(finding.structured?.gaps)) continue
      for (const gap of finding.structured.gaps) {
        if (gap?.priority !== 'high') continue
        if (typeof gap.aspect !== 'string' || gap.aspect.length === 0) continue
        if (queued.has(gap.aspect) || leads.length >= cfg.maxParallel) continue
        queued.add(gap.aspect)
        leads.push({ question: gap.aspect, followUp: true })
      }
    }
    pending = [...pending, ...leads]
    // 边际信息增益收敛：本轮没有产出任何新的 high-priority 缺口 → 循环自然结束。
  }
  exec.signal?.throwIfAborted?.()

  // ── 证据汇总（率失真之前的三态证据） ───────────────────────────────────────
  const ordered = []
  const seen = new Set()
  for (const batch of rounds) {
    for (const item of batch) {
      if (seen.has(item.question.question)) continue
      seen.add(item.question.question)
      ordered.push(item)
    }
  }
  const completed = ordered.filter(item => item.finding?.ok).length
  const failed = ordered.length - completed
  const skippedQuestions = pending.slice()
  const totalRounds = rounds.length
  const evidenceParts = []
  for (const item of ordered) {
    evidenceParts.push(item.finding?.ok
      ? renderFindings(item.question, item.finding.structured)
      : `## ${item.question.question}\n\n> 该子问题研究失败（子代理未返回结构化证据${item.finding?.diagnostic ? `：${item.finding.diagnostic}` : ''}）`)
  }
  for (const question of skippedQuestions) {
    evidenceParts.push(`## ${question.question}\n\n> 该子问题未研究（达到本次运行的子代理上限 maxTotalAgents）`)
  }
  const subquestions = completed + failed + skippedQuestions.length
  const intermediate = `# ${topic} — 深度研究中间结果（证据状态）\n\n`
    + `> 子问题 ${subquestions} 个，完成 ${completed} 个，失败 ${failed} 个，未研究 ${skippedQuestions.length} 个，研究轮次 ${totalRounds} 轮。`
    + (planText.length > 0 ? `\n\n${planText}` : '')
    + `\n\n${evidenceParts.join('\n\n---\n\n')}`

  // ── 综合：率失真压缩为最终报告 ─────────────────────────────────────────────
  let report = intermediate
  if (synthesize) {
    const synthAvailable = state.limit - state.started >= 1
    if (synthAvailable) {
      const final = await runChild({
        label: '综合',
        prompt: synthesizerPrompt(topic, purpose, planText, intermediate),
        model: cfg.synthesizerModel,
      })
      if (final.ok && final.text.trim().length > 0) {
        report = `${final.text.trim()}\n\n---\n\n## 附录：原始证据状态\n\n${intermediate}`
      } else {
        report = `${intermediate}\n\n> 注：综合子代理未产出最终报告（保留三态证据，供主代理自行撰写）。`
      }
    } else {
      report = `${intermediate}\n\n> 注：子代理预算已用尽，未运行综合子代理（保留三态证据，供主代理自行撰写）。`
    }
  }

  // ── 审查：信道纠错（可选） ─────────────────────────────────────────────────
  let reviewText
  if (review && state.limit - state.started >= 1) {
    const verdict = await runChild({
      label: '审查',
      prompt: reviewerPrompt(topic, planText, report),
      model: cfg.reviewerModel,
    })
    if (verdict.ok && verdict.text.trim().length > 0) {
      reviewText = `## 对抗性审查意见\n\n${verdict.text.trim()}`
    } else {
      reviewText = '## 对抗性审查意见\n\n> 审查子代理未产出有效意见（建议人工复核引用与覆盖度）。'
    }
  }

  exec.signal?.throwIfAborted?.()
  return {
    ok: true,
    report,
    ...(reviewText !== undefined ? { review: reviewText } : {}),
    rounds: totalRounds,
    subquestions,
    completed,
    failed,
    skipped: skippedQuestions.length,
  }
}

/**
 * Run one adaptive research round with bounded concurrency.
 * @param runChild - shared child runner.
 * @param batch - questions for this round (already sliced to the budget).
 * @param width - concurrency width (1..batch.length).
 * @param context - topic/purpose/round/model context.
 * @returns per-question findings, in batch order.
 */
async function runResearchRound(runChild, batch, width, context) {
  const findings = new Array(batch.length)
  let cursor = 0
  let stopped = false
  const worker = async () => {
    while (!stopped) {
      const index = cursor
      cursor += 1
      if (index >= batch.length) return
      try {
        findings[index] = await runChild({
          label: `研究·第${context.round}轮·${index + 1}`,
          prompt: researcherPrompt(context, batch[index]),
          schema: RESEARCHER_SCHEMA,
          model: context.model,
        })
      } catch (error) {
        stopped = true
        throw error
      }
    }
  }
  const workers = Array.from({ length: Math.min(width, batch.length) }, () => worker())
  try {
    await Promise.all(workers)
  } catch (error) {
    // Wait for the surviving workers to observe the stop flag and settle before
    // propagating; their activations are disposed inside runChild's finally.
    await Promise.allSettled(workers)
    throw error
  }
  return findings
}

/** Planner prompt: reference-signal calibration + requisite-variety decomposition. */
function plannerPrompt(topic, purpose) {
  return '你是深度研究规划代理。研究的第一步是定义问题本身：先界定答案空间，再按信息维度拆解子问题。\n\n'
    + '研究主题：' + topic
    + (purpose !== undefined ? '\n研究用途（要支撑的决策/判断）：' + purpose : '')
    + '\n\n请按以下顺序工作：\n'
    + '1. 【答案空间】用一句话界定 scope：这份研究要回答什么问题、支撑什么判断或决策；若用途未说明，明确写出你假设的用途。\n'
    + '2. 【信息维度】枚举主题空间的信息维度（如：背景与现状、关键技术/机制、主要参与者与生态、数据与规模、趋势与未来、争议与风险、政策与监管、对比分析等，按主题取舍），这是后续覆盖度检查的基准。\n'
    + '3. 【多样性拆解】每个维度至少对应一个子问题（必要多样性定律：子问题集合的多样性必须覆盖主题空间的全部维度，否则必然存在盲区）；每个子问题给出：所属维度、搜索关键词线索（中英文）、验收标准 acceptance（怎样算回答了该子问题）。\n'
    + '4. 【覆盖度假设】列出 coverage_gaps：哪些维度你无法用子问题覆盖、或信息可能极难获取。这些会被后续研究轮实际验证——如果侦察发现信息其实可得，会自动补充研究；如果确实不可得，会作为已验证盲区写入报告。\n\n'
    + '只输出 JSON，不要输出任何其他文字。'
}

/** Researcher prompt: EIG-driven perception–action loop with a three-state evidence model. */
function researcherPrompt(context, question) {
  const header = question.followUp
    ? '这是第 ' + context.round + ' 轮补充研究，针对上一轮暴露的高优先级信息缺口：'
    : (question.blind
      ? '这是对规划阶段"盲区假设"的定向侦察：验证以下方面是否真的缺乏公开信息（若确实没有，明确写进 gaps，不要勉强编造）：'
      : '你的子问题：')
  const limit = 3
  return '你是深度研究子代理。你的任务不是"尽可能多搜索"，而是以最大信息增益为准则，'
    + '把对该子问题的条件不确定性降到可接受水平，然后立即停止。\n\n'
    + '研究主题：' + context.topic + '\n' + header + question.question
    + (question.dimension !== undefined && !question.blind ? '\n所属维度：' + question.dimension : '')
    + (question.keywords !== undefined ? '\n搜索关键词线索：' + question.keywords : '')
    + (question.acceptance !== undefined ? '\n验收标准（怎样算回答完成）：' + question.acceptance : '')
    + '\n\n用内置的 web_search 工具搜索（若你的工具集中有 web_fetch，必要时可抓取具体页面；没有则只靠 web_search）。不要使用除 web_search / web_fetch 以外的工具。'
    + '\n\n感知-行动循环（每轮严格按此执行）：\n'
    + '第 0 步：根据已有知识写出你对子问题的当前最佳答案（哪怕不完整）。\n'
    + '第 1 步【预测】：列出当前最不确定的 1-3 个高熵点；为下一个查询选择预期信息增益（EIG）最高的一个，并写一句话：本轮查询针对哪个高熵点、预期新增什么信息、如果得到相反结果会如何改变答案。\n'
    + '第 2 步【行动】：执行该查询（web_search，中英文关键词都试；若你的工具集中有 web_fetch，必要时可抓取关键页面；没有则只靠 web_search）。\n'
    + '第 3 步【更新】：把新证据归入三态：confirmed（有可靠来源支撑的事实）/ uncertain（来源弱或相互矛盾的判断）/ gaps（仍未获得的信息，标注 high/medium/low 优先级）。\n'
    + '第 4 步【边际增益验证】：回答——本轮搜索是否新增了 confirmed 条目？是否改变或推翻了你之前的任何结论？'
    + '\n\n停止准则（信息论意义，满足其一即停，不要再搜）：\n'
    + '- 上一轮边际增益为零：没有新增 confirmed，也没有改变任何结论；\n'
    + '- 高优先级缺口已全部清空；\n'
    + '- 达到轮次硬上限：最多 ' + limit + ' 轮搜索。\n\n'
    + '来源评估：权威性（政府/学术/行业机构优先）、时效性（优先近 3 年）、可靠性（有引用/数据支撑）。'
    + '可信度分级：A 政府/学术/国际组织；B 行业协会/企业白皮书；C 专业媒体；D 个人博客/自媒体。'
    + '只列你实际访问过的来源。宁可不确认，也不要编造——无法确认的点放进 uncertain 或 gaps。\n\n'
    + '输出 JSON（不要输出任何其他文字）：'
    + 'confirmed 数组（每条：claim 结论、source 来源URL、confidence high/medium/low）；'
    + 'uncertain 数组（point 不确定点、reason 原因）；'
    + 'gaps 数组（aspect 缺口方面、priority high/medium/low）。'
}

/** Synthesizer prompt: lossy compression that preserves uncertainty (rate–distortion). */
function synthesizerPrompt(topic, purpose, planText, intermediate) {
  return '你是顶级行业分析师。你的产出是一次"有损压缩"：在报告长度（率）约束下，只保留对最终结论有区分度的信息，最大化决策有用性（最小化失真）。\n\n'
    + '报告主题：' + topic
    + (purpose !== undefined ? '\n研究用途（要支撑的决策/判断）：' + purpose : '')
    + (planText.length > 0 ? '\n' + planText : '')
    + '\n\n报告结构：\n## 摘要（3-5 句核心结论，含整体置信度评估）\n## 1. 背景\n## 2. 核心发现（按维度组织，每条附置信度与来源引用）\n## 3. 不确定性与矛盾（明确列出：哪些结论置信度低、哪些来源相互矛盾——不确定性本身就是重要信息，必须保留而非掩盖）\n## 4. 信息缺口与已验证盲区（规划假设的盲区经研究验证后的真实状态）\n## 5. 结论与建议（给出基于现有证据的最优判断，标注证据强度）\n## 6. 参考资料'
    + '\n\n要求：所有关键信息行内引用来源 URL；区分事实（高置信）与推断（低置信）；矛盾信息要并列呈现；用表格/对比呈现适合的数据；避免泛泛而谈；中文输出，Markdown 格式；证据不足处明确说明，不要编造。\n\n以下是研究发现：\n\n' + intermediate
}

/** Reviewer prompt: channel error correction (citations, coverage, contradictions, over-confidence). */
function reviewerPrompt(topic, planText, report) {
  return '你是研究审阅代理。你的角色是信道纠错：对报告做对抗性审查，找出证据链中的噪声与错误。若你的工具集中有 web_fetch，可用它抽查可疑来源 URL 是否真实可达、内容是否支撑引用；没有则依据 web_search 可得信息评估来源可信度。\n\n'
    + '审查维度：\n'
    + '1. 引用纠错：URL 无法访问或与结论无关？引用是否支撑对应观点？（幻觉来源 = 信道噪声，必须标出）\n'
    + '2. 覆盖度审计：对照规划阶段声明的信息维度，哪些维度证据不足或完全缺失？（Ashby 必要多样性：维度缺失 = 控制器多样性不足 = 盲区）\n'
    + '3. 信息矛盾：不同来源冲突处是否被标注并保留？\n'
    + '4. 时效性：关键数据是否过时？\n'
    + '5. 过度自信：是否有低置信结论被表述为确定事实？\n'
    + (planText.length > 0 ? '\n规划阶段声明：\n' + planText : '')
    + '\n\n只输出审查意见（Markdown，中文），不要改写报告本身：\n## 审查意见\n### 可疑来源（如有）\n### 覆盖盲区（如有）\n### 信息矛盾\n### 过度自信项\n### 需要补充研究的最高优先级缺口（如有，供下一步定向研究）\n### 总体评估与修正建议\n\n报告主题：' + topic + '\n\n以下是待审查报告：\n\n' + report
}

/** Render one researched question's three-state evidence as Markdown. */
function renderFindings(question, finding) {
  const lines = ['## ' + question.question, '']
  if (Array.isArray(finding?.confirmed) && finding.confirmed.length > 0) {
    lines.push('### 已确认事实（置信度）')
    for (const item of finding.confirmed) {
      lines.push('- ' + item.claim + '（置信度：' + confidenceLabel(item.confidence) + '，来源：' + item.source + '）')
    }
  }
  if (Array.isArray(finding?.uncertain) && finding.uncertain.length > 0) {
    lines.push('### 不确定项')
    for (const item of finding.uncertain) {
      lines.push('- ' + item.point + (typeof item.reason === 'string' && item.reason.length > 0 ? '（原因：' + item.reason + '）' : ''))
    }
  }
  if (Array.isArray(finding?.gaps) && finding.gaps.length > 0) {
    lines.push('### 信息缺口（优先级）')
    for (const item of finding.gaps) {
      lines.push('- ' + item.aspect + '（优先级：' + confidenceLabel(item.priority) + '）')
    }
  }
  if (!Array.isArray(finding?.confirmed) || finding.confirmed.length === 0) {
    lines.push('（该子问题未获得任何可确认的证据）')
  }
  return lines.join('\n')
}

/** Localized confidence/priority label. */
function confidenceLabel(value) {
  return value === 'high' ? '高' : value === 'medium' ? '中' : value === 'low' ? '低' : '中'
}

/**
 * Parse a free-form question list: one question per line, stripping list markers
 * (`1.`, `1、`, `(1)`, `- `, `* `, `• `).
 * @param raw - the tool's `questions` argument, if any.
 * @returns question entries with a `question` field.
 */
function parseQuestionList(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]\s+|\d+\s*[.、)）]\s*|[（(]\s*\d+\s*[）)]\s*)/, '').trim())
    .filter(line => line.length > 0)
    .map(question => ({ question }))
}

/** Validate a positive-integer config/argument value with a stable error prefix. */
function positiveInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`dsh-deep-research: ${label} must be a positive integer`)
  }
  return number
}

/** The abort reason to surface from a cancelled tool call. */
function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason
  const error = new Error('deep_research: aborted')
  error.name = 'AbortError'
  return error
}
